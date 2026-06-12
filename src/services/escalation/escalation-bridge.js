'use strict';

// Two-way escalation bridge. When the AI escalates a problem to the platform
// group (or a contact), the team member quote-replies the escalation message
// with the solution — and the bot relays it to the customer and keeps the
// channel open: customer replies are forwarded back to the team while the
// thread is active. The mapping key is the WhatsApp message id of every
// bot→team message (escalation_threads table).

const dbDefault = require('../../db/client');
const { enqueueOutgoingWhatsapp } = require('../../queues/message-queue');

const BRIDGE_WINDOW_MS = parseInt(process.env.ESCALATION_BRIDGE_WINDOW_MS || String(60 * 60 * 1000), 10);

async function recordThreadMessage({
  database = dbDefault,
  userId,
  whatsappMessageId,
  targetJid,
  customerSender,
  conversationId = null,
} = {}) {
  if (!userId || !whatsappMessageId || !targetJid || !customerSender) return false;
  if (!database?.isConfigured?.()) return false;
  await database.query(
    `INSERT INTO escalation_threads (user_id, whatsapp_message_id, target_jid, customer_sender, conversation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, whatsapp_message_id) DO NOTHING`,
    [userId, String(whatsappMessageId), targetJid, customerSender, conversationId],
  );
  return true;
}

async function findThreadByQuotedId({ database = dbDefault, userId, quotedId } = {}) {
  if (!userId || !quotedId || !database?.isConfigured?.()) return null;
  const result = await database.query(
    `SELECT id, customer_sender, target_jid, conversation_id
       FROM escalation_threads
      WHERE user_id = $1 AND whatsapp_message_id = $2
      LIMIT 1`,
    [userId, String(quotedId)],
  );
  return result.rows[0] || null;
}

async function findActiveThreadForCustomer({
  database = dbDefault,
  userId,
  customerSender,
  windowMs = BRIDGE_WINDOW_MS,
} = {}) {
  if (!userId || !customerSender || !database?.isConfigured?.()) return null;
  // resolved_at IS NULL: once the team's answer has been relayed, the thread
  // is CLOSED — customer messages stop forwarding to the group and the AI
  // takes the conversation back (owner feedback 2026-06-12).
  const result = await database.query(
    `SELECT id, customer_sender, target_jid, conversation_id
       FROM escalation_threads
      WHERE user_id = $1 AND customer_sender = $2
        AND resolved_at IS NULL
        AND created_at > NOW() - ($3 * interval '1 millisecond')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, customerSender, windowMs],
  );
  return result.rows[0] || null;
}

// The team's quoted message is often a DIRECTIVE to the bot ("قوله يعطينا
// ايميله"), not a ready answer — the prompt must execute directives by
// addressing the customer directly, never forward them verbatim, and never
// reveal the behind-the-scenes instruction.
function buildRephraseInstruction(teamAnswer) {
  return [
    'وصلتك رسالة داخلية من صاحب المتجر بخصوص العميل الحالي:',
    `«${teamAnswer}»`,
    'حوّلها إلى رسالة واحدة موجهة للعميل بأسلوبك المعتاد:',
    '- إذا كانت تعليمات لك (مثل: قوله كذا، اطلب منه كذا، اسأله عن كذا) فنفّذها وخاطب العميل مباشرة.',
    '- إذا كانت جواباً على سؤال العميل فصغه له بأسلوب ودي.',
    'إلزامي: لا تضف أي معلومة جديدة، ولا تحذف معلومة أو رقماً ذُكر، ولا تذكر صاحب المتجر أو الرسالة الداخلية في ردك.',
  ].join('\n');
}

// Rephrases the team's raw message in the bot's own voice WITHOUT changing the
// facts. Lazy-requires runtime-bot to avoid a circular import (runtime-bot →
// manager → ingest → bridge). Throws on failure — the caller falls back to
// the verbatim answer, which always beats silence.
//
// PRODUCTION POSTMORTEM 2026-06-12: AIClient was constructed WITHOUT the third
// costTracker argument; ai-client called costTracker.record(...) after every
// successful completion → instant TypeError → every rephrase fell back to
// verbatim. The costTracker is now mandatory here and records usage like the
// ai-worker does (best-effort).
async function rephraseTeamAnswerWithAI({ userId, teamAnswer, deps = {} }) {
  const resolveConfig = deps.resolveConfig || require('../bot/runtime-bot').resolveConfigForAI;
  const AIClient = deps.AIClient || require('../../../lib/ai-client');
  const database = deps.database || dbDefault;
  const config = await resolveConfig(userId);
  const ai = new AIClient(config, console, {
    record: async (model, inputTokens, outputTokens) => {
      try {
        await database.query(
          `INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, cost_usd)
           VALUES ($1, $2, $3, $4, 0)`,
          [userId, model, inputTokens || 0, outputTokens || 0],
        );
      } catch (_) { /* usage tracking is best-effort */ }
    },
  });
  const reply = String(
    await ai.getReply([{ role: 'user', content: buildRephraseInstruction(teamAnswer) }]) || '',
  ).trim();
  if (!reply) throw new Error('empty rephrase');
  return reply;
}

// The team member's quoted reply carries the ANSWER — the AI rephrases it in
// the bot's voice (same facts, friendlier delivery) and it ships through the
// standard outgoing pipeline with zero humanization delay. The relay CLOSES
// the thread and hands the conversation back to the AI: no more forwarding,
// no mute — anything new the AI can't answer triggers a fresh escalation.
async function relayResolutionToCustomer({
  database = dbDefault,
  enqueue = enqueueOutgoingWhatsapp,
  rephrase = rephraseTeamAnswerWithAI,
  userId,
  thread,
  text,
  authorJid = null,
} = {}) {
  const teamAnswer = String(text || '').trim();
  if (!teamAnswer || !userId || !thread?.customer_sender) return { relayed: false };
  if (!database?.isConfigured?.()) return { relayed: false };

  let reply = teamAnswer;
  let rephraseError = null;
  try {
    reply = String(await rephrase({ userId, teamAnswer }) || '').trim() || teamAnswer;
  } catch (err) {
    reply = teamAnswer; // verbatim beats silence
    rephraseError = err?.message || String(err);
    // Loud + persisted (below): the 2026-06-12 production failure was
    // swallowed silently and undiagnosable without Railway log access.
    console.warn(`${new Date().toISOString()} [escalation-bridge] rephrase failed, sending verbatim: ${rephraseError}`);
  }

  const providerMessageId = `bridge:${thread.id || 'x'}:${Date.now()}`;
  const inserted = await database.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'queued_for_send', $6::jsonb)
     RETURNING id`,
    [
      thread.conversation_id || null,
      userId,
      thread.customer_sender,
      reply,
      providerMessageId,
      JSON.stringify({ escalationBridge: true, relayedBy: authorJid, targetJid: thread.target_jid, teamAnswer, rephraseError }),
    ],
  );
  const replyMessageId = inserted.rows[0]?.id || null;

  await enqueue({
    userId,
    conversationId: thread.conversation_id || null,
    sender: thread.customer_sender,
    reply,
    replyMessageId,
    source: 'escalation_bridge',
  }, {
    jobKey: replyMessageId ? String(replyMessageId) : `bridge-${Date.now()}`,
    delay: 0,
  });

  // Close every open thread for this customer: forwarding stops here.
  await database.query(
    `UPDATE escalation_threads SET resolved_at = NOW()
      WHERE user_id = $1 AND customer_sender = $2 AND resolved_at IS NULL`,
    [userId, thread.customer_sender],
  ).catch(() => {});

  // Hand the conversation back to the AI immediately.
  if (thread.conversation_id) {
    await database.query(
      `UPDATE conversations SET escalated_until = NULL WHERE id = $1`,
      [thread.conversation_id],
    ).catch(() => {});
  }

  return { relayed: true, replyMessageId };
}

// A quote-reply in the group is NOT always an answer for the customer — the
// owner also asks the BOT for status ("وش صار معاك"، "هل انحلت؟"). Production
// 2026-06-12: such a question was relayed to the customer verbatim. Rule:
// starts with an interrogative (وش/شو/ايش/هل/كيف/متى) or asks about a reply,
// is short, and carries no directive verb aimed at the customer.
// ملاحظة: \b لا يعمل مع الحروف العربية في JS — نستخدم lookahead للمسافة بدلاً منه.
const STATUS_INTERROGATIVE_RE = /^[\s،]*((و?ش|شو|ايش|إيش|هل|كيف|متى)(?=[\s؟?]|$)|رد عليك|رد العميل)/;
const DIRECTIVE_VERB_RE = /(?:^|\s)(جرب|يجرب|تجرب|سو|يسوي|تسوي|اضغط|يضغط|حمل|يحمل|افتح|يفتح|روح|يروح|ادخل|يدخل|اعطنا|يعطينا|ارسل لنا|قوله|اطلب)(?=\s|$)/;

function isThreadStatusQuery(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  if (t.includes(':')) return false; // "الحل: ..." style answers
  if (DIRECTIVE_VERB_RE.test(t)) return false;
  return STATUS_INTERROGATIVE_RE.test(t);
}

// Deterministic status summary for the team — no AI, straight from the DB.
async function buildThreadStatusReply({ database = dbDefault, userId, thread } = {}) {
  const digits = String(thread?.customer_sender || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
  const header = `📊 وضع المحادثة مع العميل${digits ? ` (+${digits})` : ''}:`;
  try {
    const result = await database.query(
      `SELECT direction, content, created_at
         FROM messages
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC
        LIMIT 4`,
      [userId, thread?.conversation_id],
    );
    const lines = [header];
    const lastInbound = (result.rows || []).find(r => r.direction === 'inbound');
    const lastOutbound = (result.rows || []).find(r => r.direction === 'outbound');
    const ago = (d) => {
      const min = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
      return min < 60 ? `قبل ${min} دقيقة` : `قبل ${Math.round(min / 60)} ساعة`;
    };
    if (lastOutbound) lines.push(`آخر رسالة للعميل (${ago(lastOutbound.created_at)}): «${String(lastOutbound.content).slice(0, 120)}»`);
    if (lastInbound) lines.push(`آخر رد من العميل (${ago(lastInbound.created_at)}): «${String(lastInbound.content).slice(0, 120)}»`);
    else lines.push('العميل ما رد بعد.');
    lines.push('');
    lines.push('للرد على العميل: اقتبس رسالة التصعيد واكتب الجواب.');
    return lines.join('\n');
  } catch (_) {
    return `${header}\nتعذر جلب التفاصيل حالياً.`;
  }
}

// Latest thread for a TARGET (group) regardless of customer — lets the owner
// ask "وش صار" in the group without quoting (production 2026-06-12).
async function findLatestThreadForTarget({
  database = dbDefault,
  userId,
  targetJid,
  windowMs = BRIDGE_WINDOW_MS,
} = {}) {
  if (!userId || !targetJid || !database?.isConfigured?.()) return null;
  const result = await database.query(
    `SELECT id, customer_sender, target_jid, conversation_id
       FROM escalation_threads
      WHERE user_id = $1 AND target_jid = $2
        AND created_at > NOW() - ($3 * interval '1 millisecond')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, targetJid, windowMs],
  );
  return result.rows[0] || null;
}

// A suppressed escalation (anti-spam cooldown) must NOT mean silence — the
// bot already told the customer "رسلت للإدارة" (production 2026-06-12 15:57:
// the group got nothing while the customer was promised a transfer).
function buildCustomerUpdateText({ customerSender, text } = {}) {
  const digits = String(customerSender || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
  return [
    `🔁 تحديث من العميل${digits ? ` (+${digits})` : ''}:`,
    String(text || '').trim().slice(0, 300),
    '',
    'للرد عليه: رد على هذه الرسالة بالحل وسيصله مباشرة.',
  ].join('\n');
}

function buildCustomerForwardText({ customerSender, text } = {}) {
  const digits = String(customerSender || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
  return [
    `💬 رد العميل${digits ? ` (+${digits})` : ''}:`,
    String(text || '').trim(),
    '',
    'للرد عليه: رد على هذه الرسالة بالحل وسيصله مباشرة.',
  ].join('\n');
}

// While a thread is active, the customer's replies are forwarded to the team
// target as quotable messages (escalation:true + customerSender makes the
// outgoing worker record them as thread rows too — so the team can quote the
// forward itself, not just the original escalation).
async function forwardCustomerReplyToTeam({
  enqueue = enqueueOutgoingWhatsapp,
  userId,
  thread,
  customerSender,
  text,
  raw = false, // raw=true: send as-is (status summaries), no "رد العميل" wrapper
} = {}) {
  const body = String(text || '').trim();
  if (!body || !userId || !thread?.target_jid) return { forwarded: false };
  await enqueue({
    userId,
    conversationId: thread.conversation_id || null,
    sender: thread.target_jid,
    reply: raw ? body : buildCustomerForwardText({ customerSender, text: body }),
    escalation: true,
    customerSender,
    source: 'escalation_bridge_forward',
  }, {
    jobKey: `bridge-fwd-${userId}-${Date.now()}`,
    delay: 0,
  });
  return { forwarded: true };
}

module.exports = {
  recordThreadMessage,
  findThreadByQuotedId,
  findActiveThreadForCustomer,
  relayResolutionToCustomer,
  forwardCustomerReplyToTeam,
  buildCustomerForwardText,
  buildCustomerUpdateText,
  buildRephraseInstruction,
  rephraseTeamAnswerWithAI,
  isThreadStatusQuery,
  buildThreadStatusReply,
  findLatestThreadForTarget,
  BRIDGE_WINDOW_MS,
};
