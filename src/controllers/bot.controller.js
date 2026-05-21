'use strict';

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

function createBotController({ getUserBot }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

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
      const started = await bot.startBot();
      const state = bot.appState;
      if (state.status === 'error') {
        return res.status(500).json({ success: false, started, status: state.status, message: state.error || 'bot start failed' });
      }
      res.json({ success: true, started, status: state.status, message: started ? describeStartState(state) : describeStartState(state) });
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
      const { phone, message } = req.body;
      if (!phone || !message?.trim()) {
        return res.status(400).json({ success: false, message: 'phone and message are required' });
      }
      if (!bot.botRunning || !bot.client || bot.appState.status !== 'connected') {
        return res.json({ success: false, message: 'bot is not connected' });
      }

      try {
        const cleanPhone = phone.replace(/\+/g, '').replace(/[\s\-()]/g, '');
        await Promise.race([
          bot.client.sendMessage(`${cleanPhone}@c.us`, message.trim()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
        ]);
        bot.log(`direct message sent to ${cleanPhone}`);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createBotController, describeStartState };
