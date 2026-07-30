'use strict';

const { normalizeOutboundJid } = require('../whatsapp/baileys-connection-manager');

function formatIncidentMessage(kind, incident) {
  const title = kind === 'resolved' ? '✅ تعافت الخدمة' : '🚨 تنبيه: عطل في منصة جواب';
  const when = new Date().toLocaleString('ar-SA', { timeZone: process.env.MONITOR_TZ || 'Asia/Riyadh' });
  let text = `${title}\n\nالمكوّن: ${incident.component}\nالحالة: ${incident.detail || '—'}\nالخطورة: ${incident.severity === 'warning' ? 'تحذير' : 'حرجة'}\nالوقت: ${when}`;
  // WhatsApp-session incidents are actionable: the fix is always "open the
  // dashboard and re-link" — put the link in the alert itself.
  const isWhatsapp = String(incident.key || '').startsWith('whatsapp:') || String(incident.component || '').startsWith('واتساب');
  if (kind !== 'resolved' && isWhatsapp) {
    const dashboardUrl = (process.env.DASHBOARD_URL || 'https://jwap.net').trim();
    text += `\n\nلإعادة الربط افتح الرابط وامسح الباركود: ${dashboardUrl}`;
  }
  return text;
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
  webhookUrl = process.env.OWNER_ALERT_WEBHOOK_URL || '',
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
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

  // Phase 8: an OUT-OF-BAND channel that does NOT depend on the WhatsApp bot or
  // the database — so an outage in exactly those components (the times you most
  // need to know) still reaches you. Best-effort, timeout-bounded, never throws,
  // and carries no secrets (just the incident summary).
  async function sendWebhook(kind, incident, text) {
    const url = String(webhookUrl || '').trim();
    if (!url || typeof fetchImpl !== 'function') return false;
    const payload = {
      kind,
      severity: incident.severity || 'critical',
      component: incident.component,
      detail: incident.detail || '',
      key: incident.key || '',
      scope: incident.scope || '',
      text,
      at: new Date().toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), parseInt(process.env.OWNER_ALERT_WEBHOOK_TIMEOUT_MS || '5000', 10));
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return !!res && (res.ok === true || (typeof res.status === 'number' && res.status >= 200 && res.status < 300));
    } catch (err) {
      logger.warn?.('monitor', `owner webhook alert failed: ${err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatch({ kind, incident }) {
    const text = formatIncidentMessage(kind, incident);
    const subject = kind === 'resolved'
      ? `✅ تعافت: ${incident.component}`
      : `🚨 عطل: ${incident.component}`;
    const channels = [];
    // Each channel is independent & best-effort; a failure in one never blocks
    // the others, so the out-of-band webhook still fires when WhatsApp/DB are down.
    if (await sendWhatsapp(text)) channels.push('whatsapp');
    if (await sendEmail(subject, text)) channels.push('email');
    if (await sendWebhook(kind, incident, text)) channels.push('webhook');
    return channels;
  }

  return { dispatch, sendWhatsapp, sendEmail, sendWebhook };
}

module.exports = { createAlertDispatcher, formatIncidentMessage, ownerJid };
