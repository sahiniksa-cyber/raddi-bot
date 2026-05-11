'use strict';

function createConfigController({ getUserBot }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

  return {
    getConfig(req, res) {
      res.json(getUserBot(req.session.userId).config);
    },

    saveConfig(req, res) {
      try {
        const bot = getUserBot(req.session.userId);
        const incoming = req.body || {};
        const merged = { ...bot.config, ...incoming };

        if (!incoming.openaiApiKey?.trim() && bot.config.openaiApiKey?.trim()) merged.openaiApiKey = bot.config.openaiApiKey;
        if (!incoming.openrouterApiKey?.trim() && bot.config.openrouterApiKey?.trim()) merged.openrouterApiKey = bot.config.openrouterApiKey;
        if (!incoming.googleApiKey?.trim() && bot.config.googleApiKey?.trim()) merged.googleApiKey = bot.config.googleApiKey;
        if (!incoming.anthropicApiKey?.trim() && bot.config.anthropicApiKey?.trim()) merged.anthropicApiKey = bot.config.anthropicApiKey;

        bot.config = merged;
        bot.saveConfig();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: `save failed: ${err.message}` });
      }
    },

    clearConversations(req, res) {
      const bot = getUserBot(req.session.userId);
      bot.conversations.clear();
      bot.saveConversations();
      res.json({ success: true });
    },
  };
}

module.exports = { createConfigController };
