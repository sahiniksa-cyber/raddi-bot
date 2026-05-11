'use strict';

const { TIMERS } = require('../../lib/constants');

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

    start(req, res) {
      const bot = getUserBot(req.session.userId);
      const started = bot.startBot();
      res.json({ success: true, started, status: bot.appState.status });
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

module.exports = { createBotController };
