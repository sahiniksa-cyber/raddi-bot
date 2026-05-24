'use strict';

function computeEffectiveRemaining(row) {
  if (!row) return 0;
  const remaining = Number(row.messages_remaining) || 0;
  if (remaining <= 0) return 0;
  const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
  const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();
  return expired ? 0 : remaining;
}

module.exports = { computeEffectiveRemaining };
