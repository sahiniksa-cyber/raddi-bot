'use strict';

// Instant "the WhatsApp link was severed" alert. Fired the moment Baileys
// reports DisconnectReason.loggedOut (device removed / unlinked) — the one
// disconnect that NEVER self-heals and always needs a fresh QR scan. Transient
// drops keep going through the slower health monitor instead, so this path
// stays spam-free.
//
// Channel reality: the alert is sent FROM the admin's bot. If the unlinked
// session IS the admin's bot, WhatsApp cannot carry its own death notice —
// email (SMTP_* + OWNER_ALERT_EMAIL) is the only instant channel for that case.

const dbDefault = require('../../db/client');

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://jwap.net').trim();

let deps = { getOwnerBot: null, mailer: null, database: dbDefault };
const __lastSent = new Map(); // userId -> epoch ms

function configureUnlinkAlerts({ getOwnerBot = null, mailer = null, database = dbDefault } = {}) {
  deps = { getOwnerBot, mailer, database };
}

function cooldownMs() {
  return parseInt(process.env.UNLINK_ALERT_COOLDOWN_MS || String(30 * 60 * 1000), 10);
}

function buildUnlinkMessage({ phone } = {}) {
  const num = String(phone || '').replace(/[^\d]/g, '');
  const when = new Date().toLocaleString('ar-SA', { timeZone: process.env.MONITOR_TZ || 'Asia/Riyadh' });
  return [
    '🚨 تنبيه: انفصل ربط الواتساب — تم فك الربط',
    num ? `الرقم: +${num}` : null,
    'البوت متوقف عن الرد على العملاء الآن.',
    `لإعادة الربط افتح الرابط وامسح الباركود من جديد: ${DASHBOARD_URL}`,
    `الوقت: ${when}`,
  ].filter(Boolean).join('\n');
}

async function sendViaOwnerBot(jidPhone, text) {
  const digits = String(jidPhone || '').replace(/[^\d]/g, '');
  if (!digits || typeof deps.getOwnerBot !== 'function') return false;
  try {
    const bot = await deps.getOwnerBot();
    if (!bot || bot.appState?.status !== 'connected' || !bot.client?.sendMessage) return false;
    await bot.client.sendMessage(`${digits}@s.whatsapp.net`, text);
    return true;
  } catch (_) {
    return false;
  }
}

async function sendEmails(recipients, text) {
  if (!deps.mailer) return false;
  const unique = [...new Set(recipients.filter(Boolean))];
  let sent = false;
  for (const to of unique) {
    try {
      await deps.mailer.sendMail({ to, subject: '🚨 انفصل ربط الواتساب — أعد الربط الآن', text });
      sent = true;
    } catch (_) { /* best-effort */ }
  }
  return sent;
}

async function lookupMerchantContact(userId) {
  try {
    if (!deps.database?.isConfigured?.()) return {};
    const result = await deps.database.query('SELECT phone, email FROM users WHERE id = $1', [userId]);
    return result.rows[0] || {};
  } catch (_) {
    return {};
  }
}

async function sendUnlinkAlert({ userId, phone } = {}) {
  if (process.env.UNLINK_ALERT_ENABLED === 'false') return { channels: [] };
  if (!userId) return { channels: [], skipped: 'no_user' };

  const last = __lastSent.get(userId) || 0;
  if (Date.now() - last < cooldownMs()) return { channels: [], skipped: 'cooldown' };
  __lastSent.set(userId, Date.now());

  const text = buildUnlinkMessage({ phone });
  const merchant = await lookupMerchantContact(userId);
  const ownerPhone = String(process.env.OWNER_ALERT_PHONE || '').replace(/[^\d]/g, '');
  // users.phone first; fall back to the unlinked session's own number — the
  // merchant's personal WhatsApp account still receives messages (only the
  // BOT link died), so alerting that same number is reliable.
  const merchantPhone = String(merchant.phone || phone || '').replace(/[^\d]/g, '');

  const channels = [];
  if (await sendViaOwnerBot(ownerPhone, text)) channels.push('whatsapp_owner');
  if (merchantPhone && merchantPhone !== ownerPhone && await sendViaOwnerBot(merchantPhone, text)) {
    channels.push('whatsapp_merchant');
  }
  if (await sendEmails([process.env.OWNER_ALERT_EMAIL, merchant.email], text)) channels.push('email');

  console.warn(`${new Date().toISOString()} [unlink-alert] user=${userId} channels=[${channels.join(',') || 'NONE'}]`);
  return { channels };
}

module.exports = { buildUnlinkMessage, configureUnlinkAlerts, sendUnlinkAlert, __lastSent };
