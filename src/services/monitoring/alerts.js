'use strict';

const { normalizeOutboundJid } = require('../whatsapp/baileys-connection-manager');
const dbDefault = require('../../db/client');
const { PLATFORM_REPLY_POLICY } = require('../../policy/platform-reply-policy');
const { createReplyAuditStore } = require('../audit/reply-audit-store');
const { WhatsAppSendGateway } = require('../whatsapp/whatsapp-send-gateway');
const { createWhatsAppTransportAdapter } = require('../whatsapp/whatsapp-transport-adapter');
const { stableCorrelationId } = require('../whatsapp/runtime-send-gateway');

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

function createAlertSendGateway({ bot, database, allowedDestination }) {
  const gateway = new WhatsAppSendGateway({
    auditStore: createReplyAuditStore({ database }),
    policyStore: { loadMerchantPolicy: async () => null },
    scopeStore: {
      async assertSendScope(request) {
        if (request.destination !== allowedDestination
            || request.tenantScope.internalDestination !== allowedDestination) {
          const error = new Error('Alert destination is not authorized');
          error.code = 'OUTGOING_SCOPE_MISMATCH';
          throw error;
        }
      },
    },
    transport: createWhatsAppTransportAdapter({ client: bot.client }),
  });
  return gateway;
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
  database = dbDefault,
  gatewayFactory = createAlertSendGateway,
} = {}) {
  async function sendWhatsapp(text) {
    const jid = ownerJid(ownerPhone);
    if (!jid || typeof getOwnerBot !== 'function') return false;
    try {
      const bot = await getOwnerBot();
      if (!bot || bot.appState?.status !== 'connected' || !bot.client) return false;
      const userId = bot.userId;
      if (!userId || !database?.isConfigured?.()) return false;
      const idempotencyKey = `platform-alert:${stableCorrelationId(text)}`;
      const gateway = gatewayFactory({ bot, database, allowedDestination: jid });
      const result = await gateway.send({
        sendClass: 'platform_alert',
        userId,
        channelId: 'whatsapp',
        destination: jid,
        idempotencyKey: idempotencyKey,
        correlationId: stableCorrelationId(`${userId}:${idempotencyKey}`),
        content: text,
        policyVersion: PLATFORM_REPLY_POLICY.policyVersion,
        tenantScope: {
          userId,
          internalDestination: jid,
        },
      });
      return result.decision === 'sent' || result.decision === 'duplicate';
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

module.exports = {
  createAlertDispatcher,
  createAlertSendGateway,
  formatIncidentMessage,
  ownerJid,
};
