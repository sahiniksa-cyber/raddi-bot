'use strict';

const crypto = require('crypto');
const { TIMERS } = require('../../lib/constants');
const { compileMerchantPolicy } = require('../policy/merchant-policy-compiler');
const { createReplyAuditStore } = require('../services/audit/reply-audit-store');
const { WhatsAppSendGateway } = require('../services/whatsapp/whatsapp-send-gateway');
const { createWhatsAppTransportAdapter } = require('../services/whatsapp/whatsapp-transport-adapter');
const { stableCorrelationId } = require('../services/whatsapp/runtime-send-gateway');

async function loadActivePolicyVersion(database, userId) {
  const result = await database.query(
    `SELECT config->'merchantPolicy' AS merchant_policy
       FROM bot_configs WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const compiled = compileMerchantPolicy(result.rows[0]?.merchant_policy);
  if (!compiled.ok || compiled.policy.status !== 'active') {
    const error = new Error('Active merchant policy is required');
    error.code = 'POLICY_INVALID';
    throw error;
  }
  return compiled.policyVersion;
}

function createManualSendGateway({ bot, database }) {
  const gateway = new WhatsAppSendGateway({
    auditStore: createReplyAuditStore({ database }),
    policyStore: {
      async loadMerchantPolicy(userId) {
        const result = await database.query(
          `SELECT config->'merchantPolicy' AS merchant_policy
             FROM bot_configs WHERE user_id = $1 LIMIT 1`,
          [userId],
        );
        return result.rows[0]?.merchant_policy || null;
      },
    },
    scopeStore: {
      async assertSendScope(request) {
        const result = await database.query(
          `SELECT id FROM conversations
            WHERE id = $1 AND user_id = $2 AND sender = $3 AND channel_id = 'whatsapp'
            LIMIT 1`,
          [request.conversationId, request.userId, request.destination],
        );
        if (!result.rows[0]) {
          const error = new Error('Manual destination is outside the tenant conversation scope');
          error.code = 'OUTGOING_SCOPE_MISMATCH';
          throw error;
        }
      },
    },
    transport: createWhatsAppTransportAdapter({
      client: bot.client,
      timeoutMs: TIMERS.SEND_MESSAGE_TIMEOUT_MS,
    }),
  });
  return gateway;
}

function describeStartState(state = {}) {
  const status = state.status || 'unknown';
  if (status === 'qr_ready') return 'رمز QR جاهز، امسح الرمز من واتساب لإكمال الربط.';
  if (status === 'waiting_qr') return 'البوت يجهز رمز QR. انتظر لحظات ثم حدّث الصفحة، وإذا تأخر اضغط إعادة تهيئة الاتصال.';
  if (status === 'connecting' || status === 'reconnecting' || status === 'disconnected') {
    return 'البوت يحاول الاتصال الآن. انتظر لحظات، وإذا بقيت الحالة كما هي اضغط تشغيل مرة ثانية أو إعادة تشغيل.';
  }
  if (status === 'connected') return 'البوت متصل ويعمل.';
  if (state.error) return state.error;
  return 'طلب التشغيل وصل. إذا لم تتغير الحالة خلال لحظات، اضغط تشغيل مرة ثانية.';
}

function createBotController({
  getUserBot,
  database = null,
  gatewayFactory = createManualSendGateway,
}) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

  const db = database || (() => {
    try { return require('../db/client'); } catch (_) { return null; }
  })();

  return {
    status(req, res) {
      const bot = getUserBot(req.session.userId);
      const state = bot.appState;
      const { qrString, ...rest } = state;
      const logCount = rest.status === 'error' ? 20 : 8;
      res.json({
        ...rest,
        autoReplyEnabled: bot.config?.autoReplyEnabled !== false,
        totalChatsHandled: bot.totalChatsHandled,
        logs: state.logs.slice(0, logCount),
      });
    },

    async qr(req, res) {
      const bot = getUserBot(req.session.userId);
      res.json({ qr: bot.appState.qrString || null });
    },

    async qrImage(req, res) {
      const QRCode = require('qrcode');
      const bot = getUserBot(req.session.userId);
      const qr = bot.appState.qrString;
      if (!qr) return res.status(404).end();
      try {
        const buf = await QRCode.toBuffer(qr, {
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'H',
        });
        res.type('png').send(buf);
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async start(req, res) {
      const bot = getUserBot(req.session.userId);
      // Do NOT await the full connection handshake here. connection.start()
      // performs network work (fetchLatestBaileysVersion + socket handshake)
      // that can take ~20s, which would hang the button and the page. Kick it
      // off in the background and respond immediately; the dashboard polls
      // /api/status and /api/qr to reflect the real state as it progresses.
      //
      // While the manager is mid-reconnect (_running still true for the whole
      // backoff window) a plain startBot() is silently ignored — route the
      // button through restartBot() so it force-stops and reconnects now.
      const stuckReconnecting = bot.appState.status === 'reconnecting';
      Promise.resolve()
        .then(() => (stuckReconnecting ? bot.restartBot() : bot.startBot()))
        .catch((err) => { try { bot.log?.(`start failed: ${err.message}`); } catch (_) {} });
      res.json({
        success: true,
        started: true,
        status: bot.appState.status,
        message: 'بدأ التشغيل — انتظر ظهور الباركود أو الاتصال خلال لحظات.',
      });
    },

    async stop(req, res) {
      const bot = getUserBot(req.session.userId);
      try {
        await Promise.race([
          bot.stopBot(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 8000)),
        ]);
        res.json({ success: true, status: bot.appState.status });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message, status: bot.appState.status });
      }
    },

    async setAutoReply(req, res) {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'enabled must be boolean',
        });
      }

      const bot = getUserBot(req.session.userId);
      const enabled = req.body.enabled;
      bot.config = { ...(bot.config || {}), autoReplyEnabled: enabled };
      await bot.saveConfig();

      // Best-effort immediate cleanup. The AI and outgoing workers also check
      // the persisted switch, so this does not need to disconnect WhatsApp or
      // touch campaign jobs.
      let retired = 0;
      if (!enabled && db?.isConfigured?.()) {
        try {
          const result = await db.query(
            `UPDATE messages
                SET status = 'auto_reply_disabled',
                    raw_payload = (COALESCE(raw_payload, '{}'::jsonb) #- '{media,data}' #- '{media,base64}')
                                  || $2::jsonb
              WHERE user_id = $1
                AND direction = 'inbound'
                AND status = 'queued_for_ai'`,
            [
              req.session.userId,
              JSON.stringify({ autoReplyDisabledAt: new Date().toISOString() }),
            ],
          );
          retired = result.rowCount || 0;
        } catch (error) {
          bot.log?.(`warning: auto-reply queue cleanup failed: ${error.message}`);
        }
      }

      return res.json({
        success: true,
        autoReplyEnabled: enabled,
        whatsappStatus: bot.appState?.status || 'unknown',
        desiredState: bot.sessionDesiredState || 'running',
        retired,
      });
    },

    async restart(req, res) {
      const bot = getUserBot(req.session.userId);
      try {
        const started = await bot.restartBot();
        const state = bot.appState;
        res.json({ success: true, started, status: state.status, message: started ? null : 'restart requested' });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message, status: bot.appState.status });
      }
    },

    async clearSession(req, res) {
      const bot = getUserBot(req.session.userId);
      try {
        await bot.clearSession();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async sendMessage(req, res) {
      const bot = getUserBot(req.session.userId);
      const { phone, message, sender: senderJid } = req.body;
      if ((!phone && !senderJid) || !message?.trim()) {
        return res.status(400).json({ success: false, message: 'phone/sender and message are required' });
      }
      if (!bot.botRunning || !bot.client || bot.appState.status !== 'connected') {
        return res.json({ success: false, message: 'bot is not connected' });
      }

      // Prefer an explicit JID (sender) when provided — this lets the
      // conversations page reply even when the customer's phone number isn't
      // available (e.g. privacy @lid contacts or older rows with no phone).
      // Otherwise build the JID from the phone number.
      let sender;
      if (senderJid && String(senderJid).includes('@')) {
        sender = String(senderJid).trim();
      } else {
        const cleanPhone = String(phone || senderJid).replace(/\+/g, '').replace(/[\s\-()]/g, '');
        sender = `${cleanPhone}@s.whatsapp.net`;
      }
      const text = message.trim();

      try {
        if (!db?.isConfigured?.()) throw new Error('Database is required for audited manual sending');
        const userId = bot.userId || req.session.userId;
        const policyVersion = await loadActivePolicyVersion(db, userId);
        const idempotencyKey = String(
          req.body?.idempotencyKey
          || req.headers?.['idempotency-key']
          || `manual:${crypto.randomUUID()}`,
        );
        const gateway = gatewayFactory({ bot, database: db });

        const convResult = await db.query(
          `INSERT INTO conversations (user_id, sender, channel_id, last_message_at)
           VALUES ($1, $2, 'whatsapp', NOW())
           ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
           RETURNING id`,
          [userId, sender],
        );
        const conversationId = convResult.rows[0]?.id;
        if (!conversationId) throw new Error('Unable to establish manual-send conversation scope');
        const result = await gateway.send({
          sendClass: 'human_manual_reply',
          userId,
          channelId: 'whatsapp',
          destination: sender,
          conversationId,
          customerId: sender,
          idempotencyKey: idempotencyKey,
          correlationId: stableCorrelationId(`${userId}:${idempotencyKey}`),
          content: text,
          policyVersion: policyVersion,
          tenantScope: {
            userId,
            conversationId,
            customerId: sender,
          },
        });
        if (!['sent', 'duplicate'].includes(result.decision)) {
          throw new Error(`Manual send was not authorized: ${result.decision}`);
        }
        const providerMessageId = result.provider?.providerMessageId
          || result.reservation?.provider_message_id
          || `manual:${userId}:${idempotencyKey}`;
        await db.query(
          `INSERT INTO messages
             (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
           VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'sent', $6::jsonb)
           ON CONFLICT (user_id, provider_message_id) DO NOTHING`,
          [conversationId, userId, sender, text, providerMessageId,
            JSON.stringify({ source: 'manual_send', idempotencyKey })],
        );
        if (true) {
          try {
              // Owner replied manually → pause the AI on this conversation for
              // 30 minutes so it doesn't talk over the human (mirrors the
              // fromMe-on-phone behavior). escalated_until may not exist on very
              // old schemas — fail open.
              if (true) {
              try {
                await db.query(
                  `UPDATE conversations SET escalated_until = NOW() + INTERVAL '30 minutes' WHERE id = $1`,
                  [conversationId],
                );
              } catch (_) { /* column missing on old schema — ignore */ }
            }
          } catch (dbErr) {
            // Log but don't fail — message was already sent
            bot.log?.(`manual send post-send persistence failed: ${dbErr.message}`);
            throw dbErr;
          }
        }

        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = {
  createBotController,
  createManualSendGateway,
  describeStartState,
  loadActivePolicyVersion,
};
