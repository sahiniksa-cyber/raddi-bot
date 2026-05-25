'use strict';

const db = require('../../db/client');

const ALLOWED_PROVIDERS = new Set(['openai', 'google', 'anthropic', 'openrouter']);

function normalizeProvider(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(value)) {
    throw new Error(`provider غير مدعوم: ${raw}`);
  }
  return value;
}

function maskApiKey(key) {
  const value = String(key || '').trim();
  if (!value) return null;
  if (value.length <= 8) return `••••${value.slice(-4)}`;

  const firstDashIdx = value.indexOf('-');

  // No dash at all -> show first 4 chars as prefix (e.g., AIzaSy... -> AIza••••)
  if (firstDashIdx < 0) {
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  }

  // Look for compound prefix with second dash (e.g., sk-proj-, sk-ant-)
  const secondDashIdx = value.indexOf('-', firstDashIdx + 1);
  if (secondDashIdx > 0 && secondDashIdx <= 12) {
    const prefix = value.slice(0, secondDashIdx + 1);
    return `${prefix}••••${value.slice(-4)}`;
  }

  // Single dash prefix only (e.g., sk-12345678) -> show only last 4
  return `••••${value.slice(-4)}`;
}

async function getAllAdminApiKeys() {
  const { rows } = await db.query(
    'SELECT provider, api_key FROM admin_api_keys'
  );
  const out = { openai: '', google: '', anthropic: '', openrouter: '' };
  for (const row of rows) {
    out[row.provider] = row.api_key || '';
  }
  return out;
}

async function getAdminApiKeysMasked() {
  const all = await getAllAdminApiKeys();
  return {
    openai: maskApiKey(all.openai),
    google: maskApiKey(all.google),
    anthropic: maskApiKey(all.anthropic),
    openrouter: maskApiKey(all.openrouter),
  };
}

async function setAdminApiKey(provider, apiKey, adminUserId) {
  const p = normalizeProvider(provider);
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) {
    await db.query('DELETE FROM admin_api_keys WHERE provider = $1', [p]);
    return { provider: p, cleared: true };
  }
  await db.query(
    `INSERT INTO admin_api_keys (provider, api_key, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (provider) DO UPDATE
       SET api_key = EXCLUDED.api_key,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [p, trimmed, adminUserId || null]
  );
  return { provider: p, cleared: false };
}

module.exports = {
  ALLOWED_PROVIDERS,
  normalizeProvider,
  maskApiKey,
  getAllAdminApiKeys,
  getAdminApiKeysMasked,
  setAdminApiKey,
};
