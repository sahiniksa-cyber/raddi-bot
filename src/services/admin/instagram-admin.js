'use strict';

// Admin-side view + control of a SPECIFIC merchant's Instagram channel, resolved
// by user_id (NOT req.session.userId). Mirrors the WhatsApp admin controls, but
// for the token+webhook Instagram model (no socket/QR/lease). Reuses the exact
// same service functions the merchant's own dashboard uses:
//   - instagram-accounts (getAccount / disconnectAccount)
//   - instagram-config   (setAiEnabled)
// so there's no duplicated behaviour and no shared state across tenants.
//
// The read view is strictly READ-ONLY: it never seeds/inserts an IG settings row
// (unlike resolveInstagramConfig), so opening the admin card can't create rows.

const realDb = require('../../db/client');
const defaultAccounts = require('../instagram/instagram-accounts');
const defaultConfig = require('../instagram/instagram-config');

const DAY_MS = 24 * 60 * 60 * 1000;

// Aggregates a live Instagram snapshot for ONE merchant: connection + AI toggle +
// stats + token expiry + last inbound/outbound times. Best-effort: any missing
// table / query error degrades to "not connected" rather than throwing, so it
// can be safely embedded inside the broader merchant diagnostics.
async function getInstagramMerchantView(userId, deps = {}) {
  const db = deps.db || realDb;
  const accounts = deps.accounts || defaultAccounts;
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');

  let acc = null;
  try { acc = await accounts.getAccount(uid, { database: db }); } catch (_) { acc = null; }

  // Read-only settings lookup (does NOT seed a row like resolveInstagramConfig).
  let aiEnabled = false;
  let model = 'gpt-4o';
  try {
    const s = await db.query(
      'SELECT enabled, config FROM instagram_ai_settings WHERE user_id = $1',
      [uid],
    );
    if (s.rows[0]) {
      aiEnabled = s.rows[0].enabled === true;
      model = (s.rows[0].config && s.rows[0].config.model) || 'gpt-4o';
    }
  } catch (_) { /* settings best-effort */ }

  const stats = {
    activeConversations: 0,
    repliesCount: 0,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
  try {
    const a = await db.query(
      "SELECT COUNT(*)::int AS n FROM instagram_conversations WHERE user_id = $1 AND status = 'active'",
      [uid],
    );
    stats.activeConversations = a.rows[0] ? a.rows[0].n : 0;
    const r = await db.query(
      "SELECT COUNT(*)::int AS n FROM instagram_messages WHERE user_id = $1 AND direction = 'outbound' AND role = 'assistant' AND status = 'sent'",
      [uid],
    );
    stats.repliesCount = r.rows[0] ? r.rows[0].n : 0;
    const inb = await db.query(
      "SELECT created_at FROM instagram_messages WHERE user_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
      [uid],
    );
    stats.lastInboundAt = inb.rows[0] ? inb.rows[0].created_at : null;
    const outb = await db.query(
      "SELECT created_at FROM instagram_messages WHERE user_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1",
      [uid],
    );
    stats.lastOutboundAt = outb.rows[0] ? outb.rows[0].created_at : null;
  } catch (_) { /* stats best-effort */ }

  const expMs = acc && acc.token_expires_at ? new Date(acc.token_expires_at).getTime() : null;
  const nowMs = deps.now || Date.now();

  return {
    connected: Boolean(acc && acc.status === 'connected'),
    status: acc ? acc.status : 'not_connected',
    username: acc ? acc.ig_username : null,
    igUserId: acc ? acc.ig_user_id : null,
    connectedAt: acc ? acc.connected_at : null,
    tokenExpiresAt: acc ? acc.token_expires_at : null,
    tokenExpired: expMs != null ? expMs < nowMs : null,
    tokenExpiresInDays: expMs != null ? Math.floor((expMs - nowMs) / DAY_MS) : null,
    aiEnabled,
    model,
    activeConversations: stats.activeConversations,
    repliesCount: stats.repliesCount,
    lastInboundAt: stats.lastInboundAt,
    lastOutboundAt: stats.lastOutboundAt,
  };
}

// Admin force-disconnect of a merchant's Instagram — reuses the same store call
// the merchant's own "فصل الحساب" button uses (clears token, status=disconnected).
async function adminDisconnectInstagram(userId, deps = {}) {
  const db = deps.db || realDb;
  const accounts = deps.accounts || defaultAccounts;
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');
  await accounts.disconnectAccount(uid, { database: db });
  return { disconnected: true };
}

// Admin turns a merchant's Instagram auto-reply on/off — reuses the same flag the
// merchant's own toggle uses (seeds from WhatsApp on first touch, then flips).
async function adminSetInstagramAi(userId, enabled, deps = {}) {
  const db = deps.db || realDb;
  const config = deps.config || defaultConfig;
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');
  await config.setAiEnabled(uid, enabled === true, { database: db });
  return { aiEnabled: enabled === true };
}

module.exports = { getInstagramMerchantView, adminDisconnectInstagram, adminSetInstagramAi };
