'use strict';

const { normalizeOutboundJid } = require('../whatsapp/baileys-connection-manager');

function formatIncidentMessage(kind, incident) {
  const title = kind === 'resolved' ? '✅ تعافت الخدمة' : '🚨 تنبيه: عطل في منصة جواب';
  const when = new Date().toLocaleString('ar-SA', { timeZone: process.env.MONITOR_TZ || 'Asia/Riyadh' });
  return `${title}\n\nالمكوّن: ${incident.component}\nالحالة: ${incident.detail || '—'}\nالخطورة: ${incident.severity === 'warning' ? 'تحذير' : 'حرجة'}\nالوقت: ${when}`;
}

function ownerJid(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits ? normalizeOutboundJid(digits) : null;
}

/**
 * Sends incident alerts through every configured channel. Each channel is best-effort:
 * a failure in one never blocks the others, and the function never throws.
 */
function createAlertDispatcher({
  getOwnerBot = null,
  mailer = null,
  ownerPhone = process.env.OWNER_ALERT_PHONE || '',
  ownerEmail = process.env.OWNER_ALERT_EMAIL || '',
  logger = console,
} = {}) {
  async function sendWhatsapp(text) {
    const jid = ownerJid(ownerPhone);
    if (!jid || typeof getOwnerBot !== 'function') return false;
    try {
      const bot = await getOwnerBot();
      if (!bot || bot.appState?.status !== 'connected' || !bot.client) return false;
      await bot.client.sendMessage(jid, text);
      return true;
    } catch (err) {
      logger.warn?.('monitor', `owner WhatsApp alert failed: ${err.message}`);
      return false;
    }
  }

  async function sendEmail(subject, text) {
    if (!ownerEmail || !mailer) return false;
    try {
      await mailer.sendMail({ to: ownerEmail, subject, text });
      return true;
    } catch (err) {
      logger.warn?.('monitor', `owner email alert failed: ${err.message}`);
      return false;
    }
  }

  async function dispatch({ kind, incident }) {
    const text = formatIncidentMessage(kind, incident);
    const subject = kind === 'resolved'
      ? `✅ تعافت: ${incident.component}`
      : `🚨 عطل: ${incident.component}`;
    const channels = [];
    if (await sendWhatsapp(text)) channels.push('whatsapp');
    if (await sendEmail(subject, text)) channels.push('email');
    return channels;
  }

  return { dispatch, sendWhatsapp, sendEmail };
}

module.exports = { createAlertDispatcher, formatIncidentMessage, ownerJid };
