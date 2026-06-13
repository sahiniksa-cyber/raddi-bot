'use strict';

const realDb = require('../../db/client');

// Smart admin search for a merchant by phone digits, email, or name.
// Returns a small list of matching merchants with enough info to pick one.
// Admin-only — callers MUST gate this behind requireOwner.
async function searchMerchants(query, { db = realDb, limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const digits = q.replace(/[^0-9]/g, '');
  const textLike = `%${q}%`;
  const phoneLike = digits ? `%${digits}%` : '';

  // Match on email/name (text) OR on phone digits (users.phone or the linked
  // WhatsApp number in whatsapp_sessions.phone, compared digits-only).
  const result = await db.query(
    `SELECT u.id, u.name, u.email,
            COALESCE(NULLIF(ws.phone, ''), u.phone, '') AS phone,
            COALESCE(ws.status, 'stopped') AS whatsapp_status,
            ba.messages_remaining,
            COALESCE(ba.platform_access_status, 'unpaid') AS platform_access_status
       FROM users u
       LEFT JOIN whatsapp_sessions ws ON ws.user_id = u.id
       LEFT JOIN billing_accounts ba ON ba.user_id = u.id
      WHERE u.email ILIKE $1
         OR u.name ILIKE $1
         OR ($2 <> '' AND regexp_replace(COALESCE(ws.phone, ''), '[^0-9]', '', 'g') LIKE $3)
         OR ($2 <> '' AND regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE $3)
      ORDER BY u.created_at DESC
      LIMIT $4`,
    [textLike, digits, phoneLike, lim],
  );

  return result.rows.map((r) => ({
    userId: r.id,
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    whatsappStatus: r.whatsapp_status,
    messagesRemaining: r.messages_remaining == null ? null : Number(r.messages_remaining),
    platformAccessStatus: r.platform_access_status,
  }));
}

module.exports = { searchMerchants };
