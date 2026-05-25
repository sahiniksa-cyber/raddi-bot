'use strict';

const PROVIDERS = [
  { admin: 'openai',     config: 'openaiApiKey' },
  { admin: 'google',     config: 'googleApiKey' },
  { admin: 'anthropic',  config: 'anthropicApiKey' },
  { admin: 'openrouter', config: 'openrouterApiKey' },
];

function mergeApiKeys(customerConfig, adminKeys) {
  const customer = customerConfig || {};
  const admin = adminKeys || {};
  const merged = { ...customer };
  for (const p of PROVIDERS) {
    const customerKey = String(customer[p.config] || '').trim();
    const adminKey = String(admin[p.admin] || '').trim();
    merged[p.config] = customerKey || adminKey;
  }
  return merged;
}

module.exports = { mergeApiKeys, PROVIDERS };
