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
  await enqueue({ userId, sender: groupJid, reply, source: 'prompt_edit' });
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
  if (!groupMatchesEscalation(config, groupJid)) return null;

  const nowMs = now();
  const pending = await findPendingEdit(database, userId, groupJid, nowMs, ttlMinutes);

  // Confirmation flow (only meaningful when a pending edit exists).
  if (pending) {
    if (isYes(text)) {
      await applyInstructions(database, userId, pending.proposed_instructions);
      await markStatus(database, pending.id, 'applied');
      await send(enqueue, userId, groupJid, '✅ تم تعديل البرومنت. أمشي عليه من الحين.');
      logger?.info?.('prompt-edit', `applied edit ${pending.id} for ${userId}`);
      return { accepted: true, statusCode: 200, promptEdit: 'applied' };
    }
    if (isNo(text)) {
      await markStatus(database, pending.id, 'rejected');
      await send(enqueue, userId, groupJid, 'تمام، ألغيت التعديل. ما غيّرت شيء.');
      return { accepted: true, statusCode: 200, promptEdit: 'rejected' };
    }
    // Neither yes nor no — fall through; maybe it's a brand-new edit command.
  }

  const { matched, body } = detectEditCommand(text);
  if (!matched) return null;

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
  isEnabled,
  findPendingEdit,
  applyInstructions,
  listRecentEdits,
};
