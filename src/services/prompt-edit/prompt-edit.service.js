'use strict';

const { detectEditCommand, isYes, isNo } = require('../../../lib/prompt-edit-keywords');
const { compileMerchantPolicy } = require('../../policy/merchant-policy-compiler');
const { PLATFORM_REPLY_POLICY } = require('../../policy/platform-reply-policy');
const { requireActiveMerchantPolicy } = require('../ai/canonical-prompt-context');

function digitsOf(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
}

function groupMatchesEscalation(config, jid) {
  const target = digitsOf(jid);
  if (!target) return false;
  let policy;
  try {
    policy = requireActiveMerchantPolicy(config).policy;
  } catch (_) {
    return false;
  }
  return (policy.routing?.contacts || []).some(contact => (
    digitsOf(contact?.phoneNumber) === target
  ));
}

function isEnabled(config) {
  return config?.whatsappPromptEditEnabled !== false;
}

async function isKnownEscalationTarget(database, userId, jid) {
  const digits = digitsOf(jid);
  if (!digits) return false;
  try {
    const result = await database.query(
      `SELECT 1 FROM escalation_threads
        WHERE user_id = $1 AND regexp_replace(target_jid, '\\D', '', 'g') = $2
        LIMIT 1`,
      [userId, digits],
    );
    return (result?.rows?.length || 0) > 0;
  } catch (_) {
    return false;
  }
}

async function isEscalationGroup(database, config, userId, jid) {
  if (groupMatchesEscalation(config, jid)) return true;
  return isKnownEscalationTarget(database, userId, jid);
}

async function loadConfig(database, userId) {
  const result = await database.query(
    'SELECT config FROM bot_configs WHERE user_id = $1',
    [userId],
  );
  return result?.rows?.[0]?.config || {};
}

async function findPendingEdit(database, userId, sourceJid, nowMs, ttlMinutes) {
  const result = await database.query(
    `SELECT id, proposed_instructions, change_summary, created_at, target, proposed_value
       FROM prompt_edit_requests
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, sourceJid],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  if (nowMs - new Date(row.created_at).getTime() > ttlMinutes * 60 * 1000) {
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
  const result = await database.query(
    `INSERT INTO prompt_edit_requests
       (user_id, source_jid, requester_jid, request_text, current_instructions,
        proposed_instructions, change_summary, status, target, proposed_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9::jsonb)
     RETURNING id`,
    [
      row.userId,
      row.sourceJid,
      row.requesterJid,
      row.requestText,
      row.currentInstructions,
      row.proposedInstructions,
      row.changeSummary,
      row.target,
      JSON.stringify(row.proposedValue ?? null),
    ],
  );
  return result?.rows?.[0]?.id || null;
}

async function markStatus(database, id, status) {
  await database.query(
    'UPDATE prompt_edit_requests SET status = $2, decided_at = NOW() WHERE id = $1',
    [id, status],
  );
}

async function applySectionValue(database, userId, field, value) {
  if (field !== 'merchantPolicy') {
    const error = new Error('Only merchantPolicy is writable at runtime');
    error.code = 'NON_CANONICAL_POLICY_WRITE';
    throw error;
  }
  const compiled = compileMerchantPolicy(value);
  if (!compiled.ok || compiled.policy.status !== 'active') {
    const error = new Error('Merchant policy is invalid or requires review');
    error.code = 'INVALID_MERCHANT_POLICY';
    throw error;
  }
  await database.query(
    `UPDATE bot_configs
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{merchantPolicy}', $2::jsonb, true),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, JSON.stringify(compiled.policy)],
  );
  return compiled;
}

async function applyInstructions() {
  const error = new Error('Free-form runtime instructions require explicit policy review');
  error.code = 'UNTYPED_POLICY_EDIT_REQUIRES_REVIEW';
  throw error;
}

async function send(enqueue, userId, groupJid, reply) {
  await enqueue({
    userId,
    sender: groupJid,
    reply,
    systemNotice: true,
    source: 'prompt_edit',
    policyVersion: PLATFORM_REPLY_POLICY.policyVersion,
  });
}

async function tryHandle({
  database,
  userId,
  msg,
  enqueue,
  logger,
  now = Date.now,
  ttlMinutes = 10,
}) {
  const groupJid = msg?.from;
  const text = String(msg?.body || '').trim();
  if (!groupJid || !String(groupJid).includes('@g.us') || !text) return null;

  const config = await loadConfig(database, userId);
  if (!isEnabled(config)) return null;
  if (!(await isEscalationGroup(database, config, userId, groupJid))) return null;

  const pending = await findPendingEdit(database, userId, groupJid, now(), ttlMinutes);
  if (pending && (isYes(text) || isNo(text))) {
    await markStatus(database, pending.id, isNo(text) ? 'rejected' : 'needs_review');
    await send(
      enqueue,
      userId,
      groupJid,
      isNo(text)
        ? 'تم إلغاء التعديل، ولم تتغير السياسة.'
        : 'تم حفظ الطلب للمراجعة. لن يُفعّل أي تغيير غير مهيكل تلقائياً.',
    );
    return {
      accepted: true,
      statusCode: 200,
      promptEdit: isNo(text) ? 'rejected' : 'needs_review',
    };
  }

  const { matched, body } = detectEditCommand(text);
  if (!matched) return null;
  if (!body) {
    await send(enqueue, userId, groupJid, 'اكتب التعديل المطلوب بعد كلمة «تعديل».');
    return { accepted: true, statusCode: 200, promptEdit: 'help' };
  }

  await expireGroupPendings(database, userId, groupJid);
  await insertPending(database, {
    userId,
    sourceJid: groupJid,
    requesterJid: msg.author || msg.from || null,
    requestText: body,
    currentInstructions: '',
    proposedInstructions: '',
    changeSummary: 'طلب غير مهيكل يحتاج مراجعة وربطه بحقول السياسة الرسمية',
    target: 'merchant_policy_review',
    proposedValue: {
      request: body,
      activePolicyVersion: config.merchantPolicy?.policyVersion || null,
      automaticActivation: false,
    },
  });
  await send(
    enqueue,
    userId,
    groupJid,
    'حُفظ طلب التعديل للمراجعة، ولم تتغير سياسة المتجر أو معلوماته تلقائياً.',
  );
  logger?.info?.('prompt-edit', `queued canonical policy review for ${userId}`);
  return { accepted: true, statusCode: 200, promptEdit: 'needs_review' };
}

async function listRecentEdits(database, userId, limit = 10) {
  const result = await database.query(
    `SELECT id, requester_jid, change_summary, status, created_at, decided_at
       FROM prompt_edit_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result?.rows || [];
}

module.exports = {
  tryHandle,
  groupMatchesEscalation,
  isKnownEscalationTarget,
  isEscalationGroup,
  isEnabled,
  findPendingEdit,
  applyInstructions,
  applySectionValue,
  listRecentEdits,
};
