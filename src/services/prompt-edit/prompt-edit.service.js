'use strict';

const { detectEditCommand, isYes, isNo, normalizeArabic } = require('../../../lib/prompt-edit-keywords');
const { normalizeEscalationTarget } = require('../../workers/escalation-routing');
const { applyProductOp, applyInstantReplyOp, applyDoNotReplyOp } = require('../../../lib/config-edit-appliers');
const menu = require('../../../lib/edit-menu');
const { claimGroupAction: defaultClaimGroupAction } = require('../whatsapp/group-action-dedup');
const { routeEditBody } = require('../instruction-routing/route-edit');

// Structured fields the Instruction Routing Layer (#177) may write to. Whitelist —
// the field is derived from a fixed SINK map, never raw merchant input.
const ROUTED_FIELDS = new Set([
  'escalationRules', 'slaPolicies', 'tenantPolicies', 'actionRequests', 'prohibitions', 'pendingKnowledge',
]);

// Legacy structured-edit targets (products / instant replies) still store the
// full computed section value in proposed_value and write it verbatim on apply.
const SNAPSHOT_FIELD = { products: 'products', instant_replies: 'autoReplyKeywords' };

// The TOP-LEVEL config field each target ultimately writes. Used to snapshot the
// prior value on apply (for undo) and to restore it on undo.
const TARGET_TOPFIELD = {
  prompt: 'botInstructions',
  products: 'products',
  instant_replies: 'autoReplyKeywords',
  do_not_reply: 'doNotReplyList',
  reply_style_field: 'replyStyle',
  reply_style_phrases: 'replyStyle',
};

function digitsOf(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
}

// ── Escalation-chat gate ─────────────────────────────────────────────────────
// A chat is authorized to edit when it is an escalation destination — a GROUP
// or a 1:1 NUMBER (escalation isn't always a group). Authorization is strictly
// team/owner: a configured escalationContact, or a jid the bot actually
// escalated to (escalation_threads). A customer's chat matches none of these,
// so a customer can NEVER trigger an edit.
function groupMatchesEscalation(config, jid) {
  const target = digitsOf(jid);
  if (!target) return false;
  const contacts = Array.isArray(config?.escalationContacts) ? config.escalationContacts : [];
  for (const c of contacts) {
    const norm = normalizeEscalationTarget(c?.phone || c?.target || c?.jid);
    if (norm && norm.endsWith('@g.us') && digitsOf(norm) === target) return true;
  }
  return false;
}

// A 1:1 escalation NUMBER configured in escalationContacts (non-group contact
// whose digits match the sender). Lets a team member edit from their direct chat.
function contactMatchesEscalation(config, jid) {
  const target = digitsOf(jid);
  if (!target || String(jid).includes('@g.us')) return false;
  const contacts = Array.isArray(config?.escalationContacts) ? config.escalationContacts : [];
  for (const c of contacts) {
    const norm = normalizeEscalationTarget(c?.phone || c?.target || c?.jid);
    if (!norm || norm.endsWith('@g.us')) continue;
    if (digitsOf(norm) === target) return true;
  }
  return false;
}

function isEnabled(config) {
  return config?.whatsappPromptEditEnabled !== false; // default ON
}

async function isKnownEscalationTarget(database, userId, jid) {
  const digits = digitsOf(jid);
  if (!digits) return false;
  try {
    const r = await database.query(
      `SELECT 1 FROM escalation_threads
        WHERE user_id = $1 AND regexp_replace(target_jid, '\\D', '', 'g') = $2
        LIMIT 1`,
      [userId, digits],
    );
    return (r?.rows?.length || 0) > 0;
  } catch (_) {
    return false;
  }
}

// Group OR 1:1 escalation number — the authorization for editing.
async function isEscalationChat(database, config, userId, jid) {
  if (groupMatchesEscalation(config, jid)) return true;
  if (contactMatchesEscalation(config, jid)) return true;
  return isKnownEscalationTarget(database, userId, jid);
}

// Back-compat alias (older callers/tests import isEscalationGroup).
const isEscalationGroup = isEscalationChat;

async function loadConfig(database, userId) {
  const r = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
  return r?.rows?.[0]?.config || {};
}

// ── Session row helpers (the active pending row IS the session) ─────────────
async function findActiveSession(database, userId, sourceJid, nowMs, ttlMinutes) {
  const r = await database.query(
    `SELECT id, stage, section, context, target, request_text, current_instructions,
            proposed_instructions, change_summary, proposed_value, created_at
       FROM prompt_edit_requests
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, sourceJid],
  );
  const row = r?.rows?.[0];
  if (!row) return null;
  const ageMs = nowMs - new Date(row.created_at).getTime();
  if (ageMs > ttlMinutes * 60 * 1000) {
    await markTerminalAtomic(database, row.id, 'expired').catch(() => {});
    return null;
  }
  return row;
}

// Backward-compatible alias (older callers/tests import findPendingEdit).
const findPendingEdit = findActiveSession;

async function expireGroupPendings(database, userId, sourceJid) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = 'expired', decided_at = NOW()
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'`,
    [userId, sourceJid],
  );
}

async function insertSession(database, row) {
  const r = await database.query(
    `INSERT INTO prompt_edit_requests
       (user_id, source_jid, requester_jid, request_text, current_instructions,
        proposed_instructions, change_summary, status, target, proposed_value, stage, section, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9::jsonb,$10,$11,$12::jsonb)
     RETURNING id`,
    [
      row.userId, row.sourceJid, row.requesterJid || null,
      row.requestText || '', row.currentInstructions || '',
      row.proposedInstructions || '', row.changeSummary || null,
      row.target || 'prompt',
      row.proposedValue === undefined || row.proposedValue === null ? null : JSON.stringify(row.proposedValue),
      row.stage || 'menu', row.section || null,
      row.context === undefined || row.context === null ? null : JSON.stringify(row.context),
    ],
  );
  return r?.rows?.[0]?.id || null;
}

// Persist the mutable state of a session object.
async function saveSession(database, s) {
  await database.query(
    `UPDATE prompt_edit_requests
        SET stage = $2, section = $3, context = $4::jsonb, target = $5,
            request_text = $6, proposed_instructions = $7, change_summary = $8,
            proposed_value = $9::jsonb
      WHERE id = $1`,
    [
      s.id, s.stage, s.section || null,
      s.context === undefined || s.context === null ? null : JSON.stringify(s.context),
      s.target || 'prompt', s.request_text || '', s.proposed_instructions || '',
      s.change_summary || null,
      s.proposed_value === undefined || s.proposed_value === null ? null : JSON.stringify(s.proposed_value),
    ],
  );
}

// Atomic terminal transition: flips pending → status only if still pending.
// Returns true when THIS call performed the flip (so a re-delivered confirm
// that lost the message-id claim still can't double-apply / double-announce).
async function markTerminalAtomic(database, id, status) {
  const r = await database.query(
    `UPDATE prompt_edit_requests SET status = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, status],
  );
  return (r?.rows?.length || 0) > 0;
}

// Snapshot the section's PRIOR value onto the applied row so a later "تراجع" can
// restore it. { field: <top-level config key>, value: <prior content> }.
async function savePreviousValue(database, id, previous) {
  await database.query(
    `UPDATE prompt_edit_requests SET previous_value = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(previous)],
  );
}

// The most recent APPLIED edit for this chat that carries a restorable prior
// value (and isn't itself an undo). Returns null when there's nothing to revert.
async function findLastUndoableEdit(database, userId, sourceJid) {
  const r = await database.query(
    `SELECT id, target, change_summary, previous_value, proposed_value, proposed_instructions
       FROM prompt_edit_requests
      WHERE user_id = $1 AND source_jid = $2 AND status = 'applied'
        AND target <> 'undo' AND previous_value IS NOT NULL
      ORDER BY decided_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [userId, sourceJid],
  );
  return r?.rows?.[0] || null;
}

async function markRowStatus(database, id, status) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = $2 WHERE id = $1`,
    [id, status],
  );
}

// ── Config writers ──────────────────────────────────────────────────────────
async function applySectionValue(database, userId, field, value) {
  await database.query(
    `UPDATE bot_configs
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), $2::text[], $3::jsonb, true),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, `{${field}}`, JSON.stringify(value)],
  );
}

async function applyInstructions(database, userId, newInstructions) {
  return applySectionValue(database, userId, 'botInstructions', String(newInstructions || ''));
}

// Writes one replyStyle attribute, preserving the rest of the object. Mirrors
// the dashboard's derived flags so both editors stay consistent.
async function applyReplyStyleField(database, userId, config, field, value) {
  const rs = { ...(config?.replyStyle && typeof config.replyStyle === 'object' ? config.replyStyle : {}) };
  rs[field] = value;
  if (field === 'languageStyle') rs.useDialect = value === 'dialect';
  if (field === 'replyLength') rs.useShortReplies = value === 'short';
  await applySectionValue(database, userId, 'replyStyle', rs);
}

// Applies a phrase add/remove delta to a replyStyle string array (closing /
// greeting / avoidWords / avoidPhrases), computed against the FRESH config.
async function applyPhraseSection(database, userId, config, styleField, op) {
  const rs = { ...(config?.replyStyle && typeof config.replyStyle === 'object' ? config.replyStyle : {}) };
  const res = menu.applyPhraseDelta(rs[styleField], op);
  if (res.value) {
    rs[styleField] = res.value;
    await applySectionValue(database, userId, 'replyStyle', rs);
  }
  return res;
}

// ── Outgoing (systemNotice bypasses the quota gate; not billed) ─────────────
async function send(enqueue, userId, groupJid, reply) {
  await enqueue({ userId, sender: groupJid, reply, systemNotice: true, source: 'prompt_edit' });
}

function confirmMsg(summary) {
  return ['📝 التعديل:', `• ${summary}`, 'أأكّد التطبيق؟ رد بـ (نعم) أو (لا).'].join('\n');
}

const ok = (promptEdit) => ({ accepted: true, statusCode: 200, promptEdit });

/**
 * Guided edit-menu state machine. Called from the @g.us branch of message
 * ingest. Returns a result object when it handled the message (ingest must NOT
 * drop/relay it), or null to let normal group handling continue. Never throws
 * on model failure — it reports the failure to the group and returns handled.
 */
async function tryHandle({
  database, userId, msg, enqueue, buildAiClient, logger,
  now = Date.now, ttlMinutes = 10, claimGroupAction = defaultClaimGroupAction,
}) {
  // `groupJid` holds the CHAT jid — a group (@g.us) OR a 1:1 escalation number.
  const groupJid = msg?.from;
  const text = String(msg?.body || '').trim();
  if (!groupJid || !text) return null;

  const config = await loadConfig(database, userId);
  if (!isEnabled(config)) return null;
  // Authorization: group OR 1:1 escalation number, team/owner only (never a customer).
  if (!(await isEscalationChat(database, config, userId, groupJid))) return null;

  const nowMs = now();
  const session = await findActiveSession(database, userId, groupJid, nowMs, ttlMinutes);

  // `body` (text after the first word) is only needed for the "برومنت …"
  // shortcut. `isMenuTrigger` is a NARROW deliberate-trigger check — action
  // verbs never open the menu from normal chatter.
  const { body } = detectEditCommand(text);
  const firstTok = normalizeArabic((text.split(/\s+/)[0] || '').replace(/[:：،.\-_]+$/, ''));
  const isForcePrompt = (firstTok === normalizeArabic('برومنت') || firstTok === normalizeArabic('البرومنت')) && !!body;
  const isTriggerWord = menu.isMenuTrigger(firstTok)
    || firstTok === normalizeArabic('برومنت') || firstTok === normalizeArabic('البرومنت');
  // Undo the last applied edit — only meaningful when NO session is active (with
  // an active session, "تراجع" cancels it via the isNo path below).
  const isUndoTrigger = ['تراجع', 'رجع', 'ارجع', 'استرجاع', 'undo']
    .map((w) => normalizeArabic(w)).includes(firstTok);

  const willAct = !!session || isTriggerWord || isForcePrompt || isUndoTrigger;
  if (!willAct) return null;

  // Layer 1 — message-id idempotency on EVERY advancing message. A WhatsApp
  // re-delivery (connection churn) at ANY stage is a silent no-op.
  const messageId = msg?.id?._serialized || msg?.id?.id || null;
  if (messageId) {
    const first = await claimGroupAction(database, userId, messageId, 'prompt_edit');
    if (!first) {
      logger?.info?.('prompt-edit', `duplicate delivery ${messageId} ignored`);
      return ok('duplicate');
    }
  }

  const ai = async () => buildAiClient(userId); // buildAiClient may be async

  // Build/advance a confirm-stage proposal row. Reuses the existing session row
  // when present; otherwise expires any prior active session and inserts fresh.
  const proposeAndConfirm = async ({ target, requestText, proposedInstructions, proposedValue, context, summary, existing }) => {
    if (existing) {
      Object.assign(existing, {
        stage: 'confirm', target,
        request_text: requestText || existing.request_text,
        proposed_instructions: proposedInstructions || '',
        proposed_value: proposedValue === undefined ? null : proposedValue,
        change_summary: summary, context: context || null,
      });
      await saveSession(database, existing);
    } else {
      await expireGroupPendings(database, userId, groupJid);
      await insertSession(database, {
        userId, sourceJid: groupJid, requesterJid: msg.author || msg.from || null,
        stage: 'confirm', target, requestText, proposedInstructions,
        proposedValue, context, changeSummary: summary,
      });
    }
    await send(enqueue, userId, groupJid, confirmMsg(summary));
    return ok('proposed');
  };

  // Instruction Routing Layer (#177, flagged). Before a free-text instruction
  // reaches botInstructions, try to route it to a STRUCTURED sink. Operational
  // content (escalation/SLA/policy/action/prohibition) is confirmed into its own
  // field or bounced back for clarification (unresolvable target / unknown).
  // Returns a handled result, or null to fall through to the legacy prompt path.
  const tryRouteInstruction = async (instrText, existing) => {
    if (process.env.INSTRUCTION_ROUTING_ENABLED !== 'true') return null;
    let routed = null;
    try { routed = routeEditBody(instrText, config); } catch (err) {
      logger?.warn?.('prompt-edit', `instruction routing failed: ${err.message}`);
      return null;
    }
    if (!routed) return null;
    if (routed.kind === 'clarify') {
      await send(enqueue, userId, groupJid, routed.message);
      return ok('clarify');
    }
    if (routed.kind === 'store') {
      return proposeAndConfirm({
        target: `routed:${routed.field}`, requestText: instrText,
        existing: existing || null, proposedValue: routed.value, summary: routed.summary,
      });
    }
    return null;
  };

  // ── Terminal actions ──────────────────────────────────────────────────────
  const applyPending = async (s) => {
    const target = s.target || 'prompt';

    // Undo: restore a past edit's snapshotted prior value.
    if (target === 'undo') {
      const field = s.context?.field;
      try {
        if (field) await applySectionValue(database, userId, field, s.context?.value ?? null);
      } catch (err) {
        logger?.error?.('prompt-edit', `undo apply failed: ${err.message}`);
        await send(enqueue, userId, groupJid, '⚠️ صار خطأ أثناء التراجع. جرّب مرة ثانية.');
        return ok('error');
      }
      const claimedUndo = await markTerminalAtomic(database, s.id, 'applied');
      if (claimedUndo) {
        if (s.context?.origId) await markRowStatus(database, s.context.origId, 'undone').catch(() => {});
        await send(enqueue, userId, groupJid, '↩️ رجّعت آخر تعديل — القيمة رجعت مثل ما كانت قبله.');
        logger?.info?.('prompt-edit', `undo applied ${s.id} for ${userId}`);
      }
      return ok('undone');
    }

    // Snapshot the section's PRIOR value (from the config loaded before any write
    // this call) so a future "تراجع" can restore it.
    const topField = TARGET_TOPFIELD[target];
    const previous = topField ? { field: topField, value: config?.[topField] ?? null } : null;

    try {
      if (target === 'prompt') {
        await applyInstructions(database, userId, s.proposed_instructions);
      } else if (target.startsWith('routed:')) {
        const field = target.slice('routed:'.length);
        if (!ROUTED_FIELDS.has(field)) throw new Error(`unknown routed field: ${field}`);
        await applySectionValue(database, userId, field, s.proposed_value);
      } else if (SNAPSHOT_FIELD[target]) {
        await applySectionValue(database, userId, SNAPSHOT_FIELD[target], s.proposed_value);
      } else if (target === 'do_not_reply') {
        if (s.context?.op) {
          const res = applyDoNotReplyOp(config.doNotReplyList, s.context.op);
          if (res.value) await applySectionValue(database, userId, 'doNotReplyList', res.value);
        } else if (s.proposed_value != null) {
          // Legacy snapshot row (created before the delta model) — write as-is.
          await applySectionValue(database, userId, 'doNotReplyList', s.proposed_value);
        }
      } else if (target === 'reply_style_field') {
        await applyReplyStyleField(database, userId, config, s.context?.field, s.context?.value);
      } else if (target === 'reply_style_phrases') {
        await applyPhraseSection(database, userId, config, s.context?.styleField, s.context?.op || {});
      }
    } catch (err) {
      logger?.error?.('prompt-edit', `apply ${target} failed: ${err.message}`);
      await send(enqueue, userId, groupJid, '⚠️ صار خطأ أثناء الحفظ. جرّب مرة ثانية.');
      return ok('error');
    }
    const claimed = await markTerminalAtomic(database, s.id, 'applied');
    if (claimed) {
      if (previous) await savePreviousValue(database, s.id, previous).catch(() => {});
      await send(enqueue, userId, groupJid, '✅ تم الحفظ. أمشي على التعديل من الحين. (تبي ترجع؟ اكتب: تراجع)');
      logger?.info?.('prompt-edit', `applied ${target} ${s.id} for ${userId}`);
    }
    return ok('applied');
  };

  const cancelSession = async (s) => {
    const claimed = await markTerminalAtomic(database, s.id, 'rejected');
    if (claimed) await send(enqueue, userId, groupJid, 'تمام، ألغيت. ما غيّرت شيء.');
    return ok('rejected');
  };

  // ── Entering a section from the main menu ─────────────────────────────────
  const enterSection = async (s, section) => {
    s.section = section.key;
    if (section.kind === 'text') {
      s.stage = 'input';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, 'تمام. اكتب التعديل على تعليمات البوت — كل اللي تبي تضيفه أو تغيّره.');
    } else if (section.kind === 'products') {
      s.stage = 'input';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, 'تمام. اكتب التعديل على المنتجات. مثال: غيّر سعر [اسم المنتج] إلى 99، أو أضف منتج جديد …');
    } else if (section.kind === 'instant') {
      s.stage = 'input_keyword';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, 'اكتب الكلمة المفتاحية اللي إذا أرسلها العميل يرد عليها البوت رد جاهز.');
    } else if (section.kind === 'number') {
      s.stage = 'input';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, 'اكتب رقم جوال العميل لإيقاف البوت عنه. أو (احذف: الرقم) لإرجاع رد البوت له.');
    } else if (section.kind === 'style') {
      s.stage = 'subattr';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, menu.buildStyleAttrMenu());
    } else if (section.kind === 'phrases') {
      s.stage = 'input';
      s.context = { styleField: section.styleField };
      await saveSession(database, s);
      const cur = Array.isArray(config?.replyStyle?.[section.styleField]) ? config.replyStyle[section.styleField] : [];
      const preview = cur.length ? `الحالية: ${cur.join(' | ')}\n` : '';
      await send(enqueue, userId, groupJid, `${preview}اكتب العبارة للإضافة، أو (احذف: العبارة).`);
    } else if (section.kind === 'forbidden') {
      s.stage = 'subattr';
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, menu.buildForbiddenKindMenu());
    }
    return ok('section');
  };

  // ── Section input handlers ────────────────────────────────────────────────
  const handleSectionInput = async (s) => {
    if (s.section === 'prompt') {
      const routed = await tryRouteInstruction(text, s);
      if (routed) return routed;
      let proposal;
      try { proposal = await (await ai()).proposePromptEdit(config.botInstructions || '', text); } catch (err) {
        logger?.warn?.('prompt-edit', `proposePromptEdit failed: ${err.message}`);
        await send(enqueue, userId, groupJid, 'ما قدرت أفهم التعديل 😅 اكتبه بصيغة أوضح.');
        return ok('error');
      }
      return proposeAndConfirm({
        target: 'prompt', requestText: text, existing: s,
        proposedInstructions: proposal.newInstructions, summary: proposal.summary,
      });
    }

    if (s.section === 'products') {
      let plan;
      try { plan = await (await ai()).planConfigEdit(config, text); } catch (err) {
        logger?.warn?.('prompt-edit', `planConfigEdit failed: ${err.message}`);
        plan = null;
      }
      if (!plan) {
        await send(enqueue, userId, groupJid, 'ما فهمت التعديل على المنتجات — وضّح اسم المنتج والتغيير.');
        return ok('error');
      }
      if (plan.clarify) { await send(enqueue, userId, groupJid, String(plan.clarify)); return ok('clarify'); }
      const result = applyProductOp(config.products, { action: plan.action, product: plan.product, summary: plan.summary });
      if (result.error) { await send(enqueue, userId, groupJid, `⚠️ ${result.error}`); return ok('error'); }
      if (result.needsClarify) { await send(enqueue, userId, groupJid, result.needsClarify); return ok('clarify'); }
      return proposeAndConfirm({
        target: 'products', requestText: text, existing: s,
        proposedValue: result.value, summary: result.summary,
      });
    }

    if (s.section === 'do_not_reply') {
      const parsed = menu.parseListInput(text);
      const op = { action: parsed.action === 'remove' ? 'delete' : 'add', number: parsed.value };
      const result = applyDoNotReplyOp(config.doNotReplyList, op);
      if (result.error) { await send(enqueue, userId, groupJid, `⚠️ ${result.error}`); return ok('error'); }
      if (result.needsClarify) { await send(enqueue, userId, groupJid, result.needsClarify); return ok('clarify'); }
      return proposeAndConfirm({
        target: 'do_not_reply', requestText: text, existing: s,
        context: { op }, summary: result.summary,
      });
    }

    // phrases (closing/greeting) and forbidden (avoidWords/avoidPhrases)
    const styleField = s.section === 'forbidden' ? s.context?.styleField : menu.sectionByKey(s.section)?.styleField;
    if (styleField) {
      const op = menu.parseListInput(text);
      const res = menu.applyPhraseDelta(config?.replyStyle?.[styleField], op);
      if (res.error) { await send(enqueue, userId, groupJid, `⚠️ ${res.error}`); return ok('error'); }
      if (res.noop) { await send(enqueue, userId, groupJid, `${res.summary} ما في تغيير — اكتب غيرها أو (لا) للإلغاء.`); return ok('noop'); }
      return proposeAndConfirm({
        target: 'reply_style_phrases', requestText: text, existing: s,
        context: { styleField, op }, summary: res.summary,
      });
    }
    return ok('noop');
  };

  const handleInstantKeyword = async (s) => {
    s.stage = 'input_reply';
    s.context = { keyword: text };
    await saveSession(database, s);
    await send(enqueue, userId, groupJid, `تمام. اكتب الرد الجاهز اللي يرسله البوت لما يكتب العميل "${text}".`);
    return ok('await_reply');
  };

  const handleInstantReply = async (s) => {
    const keyword = s.context?.keyword || '';
    const result = applyInstantReplyOp(config.autoReplyKeywords, { keyword, reply: text });
    if (result.error) { await send(enqueue, userId, groupJid, `⚠️ ${result.error}`); return ok('error'); }
    return proposeAndConfirm({
      target: 'instant_replies', requestText: `${keyword} → ${text}`, existing: s,
      proposedValue: result.value, summary: result.summary,
    });
  };

  const handleSubAttr = async (s) => {
    const n = menu.parseSelection(text);
    if (s.section === 'reply_style') {
      const attr = n ? menu.styleAttrByNumber(n) : null;
      if (!attr) { await send(enqueue, userId, groupJid, `ما فهمت الرقم.\n${menu.buildStyleAttrMenu()}`); return ok('reprompt'); }
      s.stage = 'subvalue';
      s.context = { attr: attr.key };
      await saveSession(database, s);
      await send(enqueue, userId, groupJid, menu.buildStyleValueMenu(attr.key));
      return ok('subvalue');
    }
    // forbidden: pick word vs phrase
    const kind = n ? menu.forbiddenKindByNumber(n) : null;
    if (!kind) { await send(enqueue, userId, groupJid, `ما فهمت الرقم.\n${menu.buildForbiddenKindMenu()}`); return ok('reprompt'); }
    s.stage = 'input';
    s.context = { styleField: kind.styleField };
    await saveSession(database, s);
    await send(enqueue, userId, groupJid, `اكتب ${kind.label} للإضافة، أو (احذف: العبارة).`);
    return ok('input');
  };

  const handleSubValue = async (s) => {
    const attrKey = s.context?.attr;
    const n = menu.parseSelection(text);
    const val = n ? menu.styleValueByNumber(attrKey, n) : null;
    if (!val) { await send(enqueue, userId, groupJid, `ما فهمت الرقم.\n${menu.buildStyleValueMenu(attrKey) || ''}`); return ok('reprompt'); }
    const attr = menu.styleAttrByKey(attrKey);
    return proposeAndConfirm({
      target: 'reply_style_field', requestText: `${attr.label}=${val.v}`, existing: s,
      context: { field: attr.field, value: val.v }, summary: `${attr.label}: ${val.label}`,
    });
  };

  const handleConfirm = async (s) => {
    if (isYes(text)) return applyPending(s);
    if (isNo(text)) return cancelSession(s);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 8) {
      let intent = 'other';
      try { intent = await (await ai()).classifyReplyIntent(text); } catch (err) {
        logger?.warn?.('prompt-edit', `intent classify failed: ${err.message}`);
      }
      if (intent === 'confirm') return applyPending(s);
      if (intent === 'cancel') return cancelSession(s);
    }
    // Still unclear: re-prompt SHORT replies (production 2026-07-02: bot went
    // silent and the merchant typed "الو"). A LONG sentence is team chatter —
    // stay silent (return null → normal handling) so the bot never nags.
    if (wordCount <= 3) {
      await send(enqueue, userId, groupJid, 'عندك تعديل بانتظار التأكيد — رد بـ (نعم) للتطبيق أو (لا) للإلغاء.');
      return ok('reprompt');
    }
    return null;
  };

  const openMenu = async () => {
    await expireGroupPendings(database, userId, groupJid);
    await insertSession(database, {
      userId, sourceJid: groupJid, requesterJid: msg.author || msg.from || null, stage: 'menu',
    });
    await send(enqueue, userId, groupJid, menu.buildMainMenu());
    return ok('menu');
  };

  // Undo: propose restoring the last applied edit's prior value (confirm-gated).
  const openUndo = async () => {
    const last = await findLastUndoableEdit(database, userId, groupJid);
    if (!last || !last.previous_value?.field) {
      await send(enqueue, userId, groupJid, 'ما فيه تعديل سابق أقدر أرجّعه.');
      return ok('undo_none');
    }
    const field = last.previous_value.field;
    // "Changed since?" safety: if the current value no longer equals what this
    // edit applied, something changed afterwards (e.g. the dashboard) — warn.
    let warn = '';
    try {
      const afterVal = last.target === 'prompt' ? last.proposed_instructions : last.proposed_value;
      if (afterVal != null) {
        const cur = field === 'botInstructions' ? (config.botInstructions || '') : config[field];
        if (JSON.stringify(cur ?? null) !== JSON.stringify(afterVal ?? null)) {
          warn = '⚠️ تنبيه: الإعداد تغيّر بعد هذا التعديل — التراجع بيرجّع النسخة اللي قبله.\n';
        }
      }
    } catch (_) { /* best-effort */ }
    await expireGroupPendings(database, userId, groupJid);
    await insertSession(database, {
      userId, sourceJid: groupJid, requesterJid: msg.author || msg.from || null,
      stage: 'confirm', target: 'undo',
      changeSummary: `تراجع عن: ${last.change_summary || 'آخر تعديل'}`,
      context: { origId: last.id, field, value: last.previous_value.value ?? null },
    });
    await send(enqueue, userId, groupJid, [
      `${warn}↩️ آخر تعديل مطبّق:`,
      `• ${last.change_summary || '(بدون وصف)'}`,
      'أرجّعه للوضع اللي قبله؟ رد بـ (نعم) أو (لا).',
    ].join('\n'));
    return ok('undo_proposed');
  };

  // ── Routing ───────────────────────────────────────────────────────────────

  // Explicit "برومنت …" shortcut: section is unambiguous → straight to confirm.
  if (isForcePrompt) {
    const routed = await tryRouteInstruction(body, session || null);
    if (routed) return routed;
    let proposal;
    try { proposal = await (await ai()).proposePromptEdit(config.botInstructions || '', body); } catch (err) {
      logger?.warn?.('prompt-edit', `proposePromptEdit failed: ${err.message}`);
      await send(enqueue, userId, groupJid, 'ما قدرت أفهم التعديل 😅 اكتبه بصيغة أوضح.');
      return ok('error');
    }
    return proposeAndConfirm({
      target: 'prompt', requestText: body, existing: session || null,
      proposedInstructions: proposal.newInstructions, summary: proposal.summary,
    });
  }

  // Cancel escape hatch — works at any stage.
  if (session && isNo(text)) return cancelSession(session);

  // Undo the last applied edit (only when nothing is mid-flow).
  if (isUndoTrigger && !session) return openUndo();

  // A trigger word (re)opens the menu — except while we're waiting for free-text
  // input, where the trigger word is legitimately part of the content.
  const inInputStage = session && ['input', 'input_keyword', 'input_reply'].includes(session.stage);
  if (isTriggerWord && (!session || !inInputStage)) return openMenu();

  if (!session) return null;

  switch (session.stage) {
    case 'menu': {
      const n = menu.parseSelection(text);
      const section = n ? menu.sectionByNumber(n) : null;
      if (!section) { await send(enqueue, userId, groupJid, `ما فهمت الرقم.\n${menu.buildMainMenu()}`); return ok('reprompt'); }
      return enterSection(session, section);
    }
    case 'input': return handleSectionInput(session);
    case 'input_keyword': return handleInstantKeyword(session);
    case 'input_reply': return handleInstantReply(session);
    case 'subattr': return handleSubAttr(session);
    case 'subvalue': return handleSubValue(session);
    case 'confirm': return handleConfirm(session);
    default: return null;
  }
}

async function listRecentEdits(database, userId, limit = 10) {
  const r = await database.query(
    `SELECT id, requester_jid, change_summary, status, created_at, decided_at
       FROM prompt_edit_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return r?.rows || [];
}

module.exports = {
  tryHandle,
  groupMatchesEscalation,
  contactMatchesEscalation,
  isKnownEscalationTarget,
  isEscalationGroup,
  isEscalationChat,
  isEnabled,
  findPendingEdit,
  findActiveSession,
  findLastUndoableEdit,
  applyInstructions,
  applySectionValue,
  listRecentEdits,
};
