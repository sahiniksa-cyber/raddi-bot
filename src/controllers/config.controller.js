'use strict';

const {
  stripApiKeysFromConfigForStorage,
  API_KEY_CONFIG_FIELDS,
} = require('../services/config/api-keys-resolver');

const API_KEY_FIELDS = API_KEY_CONFIG_FIELDS.slice();

// Detect raw API-key shaped strings hiding in arbitrary fields. Used only
// for the dev assertion below; production code unconditionally strips.
const SUSPICIOUS_KEY_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{20,}$/,      // openai / anthropic
  /^AIza[0-9A-Za-z_-]{30,}$/,     // google
  /^sk-or-[A-Za-z0-9_-]{20,}$/i,  // openrouter
  /^sk-ant-[A-Za-z0-9_-]{20,}$/i, // anthropic explicit
];

function looksLikeApiKey(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 24) return false;
  return SUSPICIOUS_KEY_PATTERNS.some(re => re.test(v));
}

function assertNoApiKeyShapedFields(config) {
  if (process.env.NODE_ENV === 'production') return;
  if (!config || typeof config !== 'object') return;
  for (const [k, v] of Object.entries(config)) {
    if (looksLikeApiKey(v)) {
      console.warn(
        `[config.controller] suspicious API-key shaped value in field "${k}" — ` +
        `it will be stripped before persistence. Inspect upstream caller.`,
      );
    }
  }
}

/**
 * Legacy alias — same as stripApiKeysFromConfigForStorage but kept for
 * existing test imports and dashboard/get-config callers.
 */
function stripApiKeysFromConfig(config) {
  return stripApiKeysFromConfigForStorage(config);
}

function mergeConfigForSave({ existing, incoming, isAdmin }) {
  const existingObj = existing || {};
  const incomingObj = incoming || {};
  const filteredIncoming = { ...incomingObj };
  if (!isAdmin) {
    for (const k of API_KEY_FIELDS) delete filteredIncoming[k];
  }
  const merged = { ...existingObj, ...filteredIncoming };

  // Defense in depth: API keys live in admin_api_keys (encrypted at rest).
  // They must never be persisted into bot_configs.config — even when the
  // caller is an admin posting from the dashboard. Strip them here so a
  // single misuse anywhere upstream cannot leak the secret into JSONB.
  assertNoApiKeyShapedFields(merged);
  return stripApiKeysFromConfigForStorage(merged);
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

module.exports = {
  createConfigController,
  stripApiKeysFromConfig,
  API_KEY_FIELDS,
  mergeConfigForSave,
  looksLikeApiKey,
};
