'use strict';

const db = require('../../db/client');

function computeEffectiveRemaining(row) {
  if (!row) return 0;
  const remaining = Number(row.messages_remaining) || 0;
  if (remaining <= 0) return 0;
  const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
  const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();
  return expired ? 0 : remaining;
}

async function checkMessageQuota(userId, { database = db } = {}) {
  const result = await database.query(
    `SELECT messages_remaining, quota_expires_at, expire_resets_quota
     FROM billing_accounts WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return { canReply: false, remaining: 0, reason: 'no_account' };

  const remaining = Number(row.messages_remaining) || 0;
  const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
  const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();

  if (expired) return { canReply: false, remaining: 0, reason: 'expired', expiresAt };
  if (remaining <= 0) return { canReply: false, remaining: 0, reason: 'empty' };

  return { canReply: true, remaining, expiresAt };
}

async function decrementMessageQuota(userId, { database = db } = {}) {
  const result = await database.query(
    `UPDATE billing_accounts
     SET messages_remaining = messages_remaining - 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND messages_remaining > 0
       AND (
         NOT expire_resets_quota
         OR quota_expires_at IS NULL
         OR quota_expires_at > NOW()
       )
     RETURNING messages_remaining`,
    [userId],
  );
  if (!result.rows[0]) return { success: false };
  return { success: true, remaining: result.rows[0].messages_remaining };
}

module.exports = { computeEffectiveRemaining, checkMessageQuota, decrementMessageQuota };
