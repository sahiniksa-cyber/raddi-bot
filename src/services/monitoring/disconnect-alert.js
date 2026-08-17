'use strict';

// Platform alert fired when a store's WhatsApp link is severed and a fresh
// pairing (QR) is genuinely required — the QR_REQUIRED terminal condition, not a
// transient drop. See connection-truth.js for the classification.
//
// Hard rules (platform-level, multi-tenant, generic — no hardcoding):
//  1. Destination is EXCLUSIVELY platform_settings.platformAlertPhone, set from
//     the platform admin panel. If empty → NO alert, internal diagnostic only.
//     There is deliberately no OWNER_ALERT_PHONE / env fallback.
//  2. Transport is the platform owner bot (resolveOwnerBot) — an INDEPENDENT
//     WhatsApp session, never the tenant session that just disconnected.
//  3. Exactly one alert per real incident (cross-replica once-only lock via
//     health_incidents), scoped by userId so tenants never leak into each other.
//     A delivery failure does NOT burn the incident — it can be retried until
//     one channel succeeds; a reconnect resolves it so a future severance alerts
//     again.
//  4. The message is minimal and leaks nothing sensitive (no userId, error,
//     stack, credentials, session info, QR, or tokens).

const dbDefault = require('../../db/client');
const { getPlatformAlertPhone, getPlatformUrl } = require('../platform/platform-alert-config');
const { recordIncidentOpen, recordIncidentResolved, markIncidentChannels, getOpenIncident, listOpenUnnotifiedIncidents } = require('./incident-store');

const INCIDENT_COMPONENT = 'whatsapp_link';

let deps = { getOwnerBot: null, database: dbDefault };

// Bounded retry state (in-process). The first alert send can fail — the owner
// bot (the independent transport) may be momentarily disconnected — leaving the
// incident open-but-unnotified. A periodic sweep (driven by the existing health
// monitor tick) re-attempts delivery until one channel succeeds.
const __retryCooldown = new Map(); // userId -> last retry-attempt epoch ms
let __retrySweepInFlight = false;   // single-flight: never run two sweeps at once

function retryCooldownMs() {
  return parseInt(process.env.DISCONNECT_ALERT_RETRY_COOLDOWN_MS || '60000', 10);
}

function configureDisconnectAlerts({ getOwnerBot = null, database = dbDefault } = {}) {
  deps = { getOwnerBot, database };
}

function buildDisconnectAlertMessage({ storeName, platformUrl } = {}) {
  const store = String(storeName || '').trim();
  const url = String(platformUrl || '').trim();
  const head = store ? `تم فصل ربط واتساب لمتجر ${store}.` : 'تم فصل ربط واتساب.';
  // Never invent a URL when the platform URL is not configured.
  if (!url) return head;
  return `${head}\nلإعادة الربط:\n${url}`;
}

async function lookupStoreName(userId, database) {
  try {
    if (!database?.isConfigured?.()) return '';
    const result = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
    const config = result.rows[0]?.config || {};
    return String(config.storeName || '').trim();
  } catch (_) {
    return '';
  }
}

async function sendViaOwnerBot(digits, text, getOwnerBot) {
  if (!digits || typeof getOwnerBot !== 'function') return false;
  try {
    const bot = await getOwnerBot();
    if (!bot || bot.appState?.status !== 'connected' || !bot.client?.sendMessage) return false;
    await bot.client.sendMessage(`${digits}@s.whatsapp.net`, text);
    return true;
  } catch (_) {
    return false;
  }
}

function diagnostic(userId, note) {
  console.warn(`${new Date().toISOString()} [disconnect-alert] user=${userId} ${note}`);
}

async function sendDisconnectAlert({ userId } = {}) {
  if (process.env.DISCONNECT_ALERT_ENABLED === 'false') return { channels: [], skipped: 'disabled' };
  if (!userId) return { channels: [], skipped: 'no_user' };

  const database = deps.database;

  // (1) Destination is exclusively the platform alert phone.
  let platformPhone = '';
  try { platformPhone = await getPlatformAlertPhone({ database }); } catch (_) { platformPhone = ''; }
  if (!platformPhone) {
    diagnostic(userId, 'skipped=no_platform_phone (اضبط "رقم جوال تنبيهات المنصة" في لوحة الإدارة)');
    return { channels: [], skipped: 'no_platform_phone' };
  }

  // (3) Once-only incident lock. recordIncidentOpen returns true only for the
  // process/replica that first opened it.
  const incident = { component: INCIDENT_COMPONENT, scope: userId, severity: 'critical', detail: 'whatsapp link severed' };
  let firstOpen = true;
  try { firstOpen = await recordIncidentOpen(database, incident); } catch (_) { firstOpen = true; }

  if (!firstOpen) {
    // Already open — only skip if a prior attempt actually delivered. Otherwise
    // retry so a channel-less first attempt (e.g. owner bot was down) can land.
    try {
      const open = await getOpenIncident(database, INCIDENT_COMPONENT, userId);
      const notified = Array.isArray(open?.notified_channels) ? open.notified_channels : [];
      if (notified.length) return { channels: [], skipped: 'already_notified' };
    } catch (_) { /* fall through to retry */ }
  }

  // (4) Minimal message.
  let platformUrl = '';
  try { platformUrl = await getPlatformUrl({ database }); } catch (_) { platformUrl = ''; }
  const storeName = await lookupStoreName(userId, database);
  const text = buildDisconnectAlertMessage({ storeName, platformUrl });

  // (2) Independent transport only.
  const channels = [];
  if (await sendViaOwnerBot(platformPhone, text, deps.getOwnerBot)) channels.push('whatsapp_platform');

  if (channels.length) {
    try { await markIncidentChannels(database, incident, channels); } catch (_) { /* best-effort */ }
  }
  diagnostic(userId, `channels=[${channels.join(',') || 'NONE'}]`);
  return { channels };
}

// Periodic retry of alerts whose first send failed. Reuses the once-only,
// notified-aware sendDisconnectAlert: an incident that is already notified is
// skipped inside it, and a successful send marks it notified so it drops out of
// the pending set — so this can run every tick without ever double-sending.
// Guards: a single-flight lock (no parallel sweeps) + a per-incident cooldown
// (no spam). Cross-replica duplicates are prevented naturally — sendViaOwnerBot
// only sends from the replica whose owner bot is actually 'connected'.
async function retryPendingDisconnectAlerts() {
  if (process.env.DISCONNECT_ALERT_ENABLED === 'false') return { retried: 0, skipped: 'disabled' };
  if (__retrySweepInFlight) return { retried: 0, skipped: 'in_flight' };
  __retrySweepInFlight = true;
  try {
    const database = deps.database;
    let pending = [];
    try { pending = await listOpenUnnotifiedIncidents(database, INCIDENT_COMPONENT); } catch (_) { pending = []; }
    const now = Date.now();
    const cooldown = retryCooldownMs();
    let retried = 0;
    for (const userId of pending) {
      const last = __retryCooldown.get(userId) || 0;
      if (now - last < cooldown) continue; // per-incident cooldown — no rapid re-send
      __retryCooldown.set(userId, now);
      const result = await sendDisconnectAlert({ userId });
      if (result.channels && result.channels.length) {
        __retryCooldown.delete(userId); // delivered — incident is now notified
        retried++;
      }
    }
    return { retried };
  } finally {
    __retrySweepInFlight = false;
  }
}

// Called when a store's session comes back to CONNECTED: closes the open
// incident so a genuinely new future severance is allowed to alert again.
async function resolveDisconnectIncident({ userId } = {}) {
  if (!userId) return false;
  __retryCooldown.delete(userId); // clear any stale retry cooldown for this tenant
  try {
    return await recordIncidentResolved(deps.database, { component: INCIDENT_COMPONENT, scope: userId, detail: 'reconnected' });
  } catch (_) {
    return false;
  }
}

module.exports = {
  buildDisconnectAlertMessage,
  configureDisconnectAlerts,
  sendDisconnectAlert,
  retryPendingDisconnectAlerts,
  resolveDisconnectIncident,
  INCIDENT_COMPONENT,
};
