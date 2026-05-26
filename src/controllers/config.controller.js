'use strict';

const API_KEY_FIELDS = ['openaiApiKey', 'googleApiKey', 'anthropicApiKey', 'openrouterApiKey'];

function stripApiKeysFromConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const out = { ...config };
  for (const k of API_KEY_FIELDS) delete out[k];
  return out;
}

function mergeConfigForSave({ existing, incoming, isAdmin }) {
  const existingObj = existing || {};
  const incomingObj = incoming || {};
  const filteredIncoming = { ...incomingObj };
  if (!isAdmin) {
    for (const k of API_KEY_FIELDS) delete filteredIncoming[k];
  }
  return { ...existingObj, ...filteredIncoming };
}

function createConfigController({ getUserBot }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

  return {
    getConfig(req, res) {
      res.json(stripApiKeysFromConfig(getUserBot(req.session.userId).config));
    },

    saveConfig(req, res) {
      try {
        const bot = getUserBot(req.session.userId);
        const incoming = req.body || {};
        const isAdmin = req.session?.isAdmin === true;
        const merged = mergeConfigForSave({ existing: bot.config, incoming, isAdmin });

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

module.exports = { createConfigController, stripApiKeysFromConfig, API_KEY_FIELDS, mergeConfigForSave };
