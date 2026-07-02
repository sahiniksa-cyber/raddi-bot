'use strict';

const { detectEditCommand, isYes, isNo } = require('../../../lib/prompt-edit-keywords');
const { normalizeEscalationTarget } = require('../../workers/escalation-routing');

function digitsOf(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
}

// True when `jid` is one of the escalation contacts configured as a GROUP.
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

function isEnabled(config) {
  return config?.whatsappPromptEditEnabled !== false; // default ON
}

// True when the bot has ACTUALLY escalated to this jid before (escalation_threads
// is the ground truth). Merchants rarely paste the real group JID into
// escalationContacts — the group is resolved at runtime — so config matching
// alone misses live escalation groups (production bug 2026-07-01). No time
// window: any past escalation to this group qualifies it. Fail-closed to false.
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

// A group qualifies for prompt-edit if it's configured as an escalation contact
// OR it's a real escalation destination the bot has used.
async function isEscalationGroup(database, config, userId, jid) {
  if (groupMatchesEscalation(config, jid)) return true;
  return isKnownEscalationTarget(database, userId, jid);
}

async function loadConfig(database, userId) {
  const r = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
  return r?.rows?.[0]?.config || {};
}

async function findPendingEdit(database, userId, sourceJid, nowMs, ttlMinutes) {
  const r = await database.query(
    `SELECT id, proposed_instructions, change_summary, created_at
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
    await markStatus(database, row.id, 'expired').catch(() => {});
    return null;
  }
  return row;
}

async function expireGroupPendings(database, userId, sourceJid) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = 'expired', decided_at = NOW()
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'`,
    [userId, sourceJid],
  );
}

async function insertPending(database, row) {
  const r = await database.query(
    `INSERT INTO prompt_edit_requests
       (user_id, source_jid, requester_jid, request_text, current_instructions, proposed_instructions, change_summary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [row.userId, row.sourceJid, row.requesterJid, row.requestText, row.currentInstructions, row.proposedInstructions, row.changeSummary],
  );
  return r?.rows?.[0]?.id || null;
}

async function markStatus(database, id, status) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = $2, decided_at = NOW() WHERE id = $1`,
    [id, status],
  );
}

async function applyInstructions(database, userId, newInstructions) {
  await database.query(
    `UPDATE bot_configs
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{botInstructions}', $2::jsonb, true),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, JSON.stringify(String(newInstructions || ''))],
  );
}

async function send(enqueue, userId, groupJid, reply) {
  // systemNotice: these are control/confirmation messages to the team group —
  // NOT billable customer replies. The flag makes the outgoing worker bypass the
  // message-quota gate (so an empty balance can't silence the confirmation) and
  // skip decrementing the merchant's quota. (production fix 2026-07-01)
  await enqueue({ userId, sender: groupJid, reply, systemNotice: true, source: 'prompt_edit' });
}

/**
 * Main entry. Called from the @g.us branch of message ingest. Returns a result
 * object when it handled the message (so ingest must NOT drop or relay it), or
 * null to let normal group handling continue. Never throws on model failure —
 * it reports the failure to the group and returns a handled result.
 */
async function tryHandle({ database, userId, msg, enqueue, buildAiClient, logger, now = Date.now, ttlMinutes = 10 }) {
  const groupJid = msg?.from;
  const text = String(msg?.body || '').trim();
  if (!groupJid || !String(groupJid).includes('@g.us') || !text) return null;

  const config = await loadConfig(database, userId);
  if (!isEnabled(config)) return null;
  if (!(await isEscalationGroup(database, config, userId, groupJid))) return null;

  const nowMs = now();
  const pending = await findPendingEdit(database, userId, groupJid, nowMs, ttlMinutes);

  const applyPending = async () => {
    await applyInstructions(database, userId, pending.proposed_instructions);
    await markStatus(database, pending.id, 'applied');
    await send(enqueue, userId, groupJid, '✅ تم تعديل البرومنت. أمشي عليه من الحين.');
    logger?.info?.('prompt-edit', `applied edit ${pending.id} for ${userId}`);
    return { accepted: true, statusCode: 200, promptEdit: 'applied' };
  };
  const cancelPending = async () => {
    await markStatus(database, pending.id, 'rejected');
    await send(enqueue, userId, groupJid, 'تمام، ألغيت التعديل. ما غيّرت شيء.');
    return { accepted: true, statusCode: 200, promptEdit: 'rejected' };
  };

  // Confirmation flow (only meaningful when a pending edit exists).
  // Fast path: obvious yes/no words are handled instantly with no AI cost.
  if (pending) {
    if (isYes(text)) return applyPending();
    if (isNo(text)) return cancelPending();
    // Neither obvious yes nor no — fall through; maybe it's a brand-new edit command.
  }

  const { matched, body } = detectEditCommand(text);
  if (!matched) {
    if (pending) {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      // ANY natural confirmation wording should work — not a fixed keyword list.
      // For short-ish replies, ask the AI whether the merchant means confirm /
      // cancel / other. Fail-safe: 'other' on any error (never auto-acts).
      if (wordCount <= 8) {
        let intent = 'other';
        try {
          const ai = await buildAiClient(userId);
          intent = await ai.classifyReplyIntent(text);
        } catch (err) {
          logger?.warn?.('prompt-edit', `intent classify failed: ${err.message}`);
        }
        if (intent === 'confirm') return applyPending();
        if (intent === 'cancel') return cancelPending();
      }
      // Still unclear: for a SHORT reply, remind instead of going silent
      // (production 2026-07-02: the bot went quiet and the merchant typed "الو").
      if (wordCount <= 3) {
        await send(enqueue, userId, groupJid, 'عندك تعديل بانتظار التأكيد — رد بـ (نعم) للتطبيق أو (لا) للإلغاء.');
        return { accepted: true, statusCode: 200, promptEdit: 'reprompt' };
      }
    }
    return null;
  }

  if (!body) {
    await send(enqueue, userId, groupJid,
      'اكتب التعديل بعد كلمة "تعديل". مثال: تعديل: أضف إننا نوصّل للرياض مجاناً.');
    return { accepted: true, statusCode: 200, promptEdit: 'help' };
  }

  let proposal;
  try {
    const ai = await buildAiClient(userId);
    proposal = await ai.proposePromptEdit(config.botInstructions || '', body);
  } catch (err) {
    logger?.warn?.('prompt-edit', `model failed: ${err.message}`);
    await send(enqueue, userId, groupJid, 'ما قدرت أفهم التعديل 😅 جرّب تكتبه بصيغة أوضح.');
    return { accepted: true, statusCode: 200, promptEdit: 'error' };
  }

  await expireGroupPendings(database, userId, groupJid);
  await insertPending(database, {
    userId,
    sourceJid: groupJid,
    requesterJid: msg.author || msg.from || null,
    requestText: body,
    currentInstructions: config.botInstructions || '',
    proposedInstructions: proposal.newInstructions,
    changeSummary: proposal.summary,
  });

  const reply = [
    '📝 فهمت التعديل:',
    `• ${proposal.summary}`,
    'أأكّد التطبيق؟ رد بـ (نعم) للتطبيق أو (لا) للإلغاء.',
  ].join('\n');
  await send(enqueue, userId, groupJid, reply);
  logger?.info?.('prompt-edit', `proposed edit for ${userId} in ${groupJid}`);
  return { accepted: true, statusCode: 200, promptEdit: 'proposed' };
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
  isKnownEscalationTarget,
  isEscalationGroup,
  isEnabled,
  findPendingEdit,
  applyInstructions,
  listRecentEdits,
};
