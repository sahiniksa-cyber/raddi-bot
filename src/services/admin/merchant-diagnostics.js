'use strict';

const realDb = require('../../db/client');

// Aggregates a live diagnostic snapshot for ONE merchant (by user_id):
// identity + billing/quota + WhatsApp session row + live in-memory bot state
// + recent message status counts + last reply time. Returns null if the user
// does not exist. Admin-only — gate behind requireOwner.
async function getMerchantDiagnostics(userId, { db = realDb, getUserBot = null } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');

  const infoRes = await db.query(
    `SELECT u.id, u.name, u.email, COALESCE(u.phone, '') AS phone, u.role, u.created_at,
            ba.messages_remaining, ba.quota_expires_at, ba.expire_resets_quota,
            COALESCE(ba.platform_access_status, 'unpaid') AS platform_access_status,
            ba.last_topup_at, ba.last_topup_amount,
            ws.status AS ws_status, COALESCE(ws.phone, '') AS ws_phone,
            ws.last_connected_at, ws.last_disconnected_at, ws.last_error,
            ws.reconnect_count, ws.desired_state,
            ws.connection_owner, ws.connection_lease_expires_at
       FROM users u
       LEFT JOIN billing_accounts ba ON ba.user_id = u.id
       LEFT JOIN whatsapp_sessions ws ON ws.user_id = u.id
      WHERE u.id = $1`,
    [uid],
  );
  if (!infoRes.rows[0]) return null;
  const row = infoRes.rows[0];

  // Message status counts over the last 7 days (GROUP BY status — robust to
  // whatever status values exist; we don't hardcode the enum).
  const countsRes = await db.query(
    `SELECT status, COUNT(*)::int AS n
       FROM messages
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY status`,
    [uid],
  );
  const messageCounts = {};
  for (const r of countsRes.rows) messageCounts[r.status] = r.n;

  const lastReplyRes = await db.query(
    `SELECT created_at FROM messages
      WHERE user_id = $1 AND direction = 'outbound'
      ORDER BY created_at DESC LIMIT 1`,
    [uid],
  );

  // Live in-memory bot state (optional). getUserBot may create+load the bot;
  // load() only auto-starts a connection when desired_state='running'
  // (mirrors boot-recovery) — never for a stopped merchant.
  let live = null;
  if (typeof getUserBot === 'function') {
    try {
      const bot = await getUserBot(uid);
      const s = bot.appState || {};
      live = {
        status: s.status || null,
        statusAgeMs: s.statusAgeMs || 0,
        error: s.error || null,
        reconnectCount: s.reconnectCount || 0,
        desiredState: s.desiredState || null,
        inConnConflictBackoff:
          typeof bot.isInConnConflictBackoff === 'function' ? bot.isInConnConflictBackoff() : null,
        logs: Array.isArray(s.logs) ? s.logs.slice(0, 8) : [],
      };
    } catch (err) {
      live = { error: err.message };
    }
  }

  return {
    identity: {
      userId: row.id,
      name: row.name || '',
      email: row.email || '',
      phone: row.ws_phone || row.phone || '',
      role: row.role,
      createdAt: row.created_at,
    },
    billing: {
      messagesRemaining: row.messages_remaining == null ? null : Number(row.messages_remaining),
      quotaExpiresAt: row.quota_expires_at || null,
      expireResetsQuota: row.expire_resets_quota,
      platformAccessStatus: row.platform_access_status,
      lastTopupAt: row.last_topup_at || null,
      lastTopupAmount: row.last_topup_amount == null ? null : Number(row.last_topup_amount),
    },
    whatsapp: {
      status: row.ws_status || 'stopped',
      phone: row.ws_phone || '',
      desiredState: row.desired_state || null,
      lastConnectedAt: row.last_connected_at || null,
      lastDisconnectedAt: row.last_disconnected_at || null,
      lastError: row.last_error || null,
      reconnectCount: row.reconnect_count == null ? 0 : Number(row.reconnect_count),
      leaseOwner: row.connection_owner || null,
      leaseExpiresAt: row.connection_lease_expires_at || null,
    },
    live,
    messageCounts,
    lastReplyAt: lastReplyRes.rows[0]?.created_at || null,
  };
}

// Force-clears the WhatsApp connection lease for a merchant REGARDLESS of who
// holds it. Needed when a dead instance left a stale lease that the live
// instance's own releaseConnectionLease() (owner-scoped) cannot clear.
async function forceReleaseLease(userId, { db = realDb } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');
  const res = await db.query(
    `UPDATE whatsapp_sessions
        SET connection_owner = NULL, connection_lease_expires_at = NULL
      WHERE user_id = $1`,
    [uid],
  );
  return { released: res.rowCount > 0 };
}

module.exports = { getMerchantDiagnostics, forceReleaseLease };
