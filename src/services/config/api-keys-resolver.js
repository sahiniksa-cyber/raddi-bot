'use strict';

/**
 * api-keys-resolver
 *
 * `mergeApiKeys` produces an effective config that combines a customer's
 * own config with the admin-level fallback keys. The merged result MUST
 * stay in memory only and never be persisted back to `bot_configs.config`,
 * otherwise an admin-managed key would leak into per-customer storage.
 *
 * Use `stripApiKeysFromConfigForStorage` immediately before any DB write to
 * `bot_configs.config` (and any other JSONB column that mirrors `bot.config`).
 */

const PROVIDERS = [
  { admin: 'openai',     config: 'openaiApiKey' },
  { admin: 'google',     config: 'googleApiKey' },
  { admin: 'anthropic',  config: 'anthropicApiKey' },
  { admin: 'openrouter', config: 'openrouterApiKey' },
];

const API_KEY_CONFIG_FIELDS = PROVIDERS.map(p => p.config);

/**
 * Merge admin-level API keys into a customer's config.
 *
 * IMPORTANT — the returned object is intended for in-memory use ONLY (e.g.
 * building an OpenAI client). Do NOT pass it to any code path that writes
 * `bot_configs.config`. Strip API keys with
 * `stripApiKeysFromConfigForStorage` first.
 */
function mergeApiKeys(customerConfig, adminKeys) {
  const customer = customerConfig || {};
  const admin = adminKeys || {};
  const merged = { ...customer };
  for (const p of PROVIDERS) {
    const customerKey = String(customer[p.config] || '').trim();
    const adminKey = String(admin[p.admin] || '').trim();
    merged[p.config] = customerKey || adminKey;
  }
  // Flag for downstream guards / debugging: this object embeds resolved keys
  // and must never be persisted.
  Object.defineProperty(merged, '__inMemoryOnly', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return merged;
}

/**
 * Remove every API key field from a config object before it is persisted.
 * Returns a new object — does not mutate the input.
 */
function stripApiKeysFromConfigForStorage(config) {
  if (!config || typeof config !== 'object') return {};
  const out = { ...config };
  for (const field of API_KEY_CONFIG_FIELDS) {
    delete out[field];
  }
  return out;
}

module.exports = {
  mergeApiKeys,
  stripApiKeysFromConfigForStorage,
  PROVIDERS,
  API_KEY_CONFIG_FIELDS,
};
