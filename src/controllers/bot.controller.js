'use strict';

const crypto = require('crypto');
const { TIMERS } = require('../../lib/constants');

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

function createBotController({ getUserBot, database = null }) {
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
      Promise.resolve()
        .then(() => bot.startBot())
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
        await Promise.race([
          bot.client.sendMessage(sender, text),
          new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
        ]);
        bot.log(`direct message sent to ${sender}`);

        // Persist to DB so the message appears in conversation history
        if (db && typeof db.isConfigured === 'function' && db.isConfigured()) {
          try {
            const userId = bot.userId || req.session.userId;
            const convResult = await db.query(
              `INSERT INTO conversations (user_id, sender, last_message_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
               RETURNING id`,
              [userId, sender],
            );
            const conversationId = convResult.rows[0]?.id;
            if (conversationId) {
              const providerMessageId = `manual:${userId}:${crypto.randomUUID()}`;
              await db.query(
                `INSERT INTO messages
                   (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
                 VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'sent', $6::jsonb)`,
                [conversationId, userId, sender, text, providerMessageId,
                  JSON.stringify({ source: 'manual_send' })],
              );
              // Owner replied manually → pause the AI on this conversation for
              // 30 minutes so it doesn't talk over the human (mirrors the
              // fromMe-on-phone behavior). escalated_until may not exist on very
              // old schemas — fail open.
              try {
                await db.query(
                  `UPDATE conversations SET escalated_until = NOW() + INTERVAL '30 minutes' WHERE id = $1`,
                  [conversationId],
                );
              } catch (_) { /* column missing on old schema — ignore */ }
            }
          } catch (dbErr) {
            // Log but don't fail — message was already sent
            bot.log?.(`warning: failed to persist manual send to DB: ${dbErr.message}`);
          }
        }

        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createBotController, describeStartState };
