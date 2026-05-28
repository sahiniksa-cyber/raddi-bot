'use strict';

const db = require('../../db/client');
const { encrypt, decrypt, isEncryptionAvailable } = require('../security/secrets');

const ALLOWED_PROVIDERS = new Set(['openai', 'google', 'anthropic', 'openrouter']);
const FORMAT_PLAINTEXT = 'plaintext';
const FORMAT_AES_GCM = 'aes-256-gcm';

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

/**
 * Read one row's plaintext API key, decrypting if necessary.
 * Also performs a lazy upgrade: if encryption is now available and the row
 * is still plaintext, re-store it encrypted in the background. Failures
 * during upgrade are logged but never thrown to the caller.
 */
function extractPlaintextFromRow(row) {
  if (!row) return '';
  const format = row.api_key_format || FORMAT_PLAINTEXT;
  if (format === FORMAT_AES_GCM) {
    if (!row.api_key_encrypted || !row.api_key_iv || !row.api_key_tag) return '';
    try {
      return decrypt({
        ciphertext: row.api_key_encrypted,
        iv: row.api_key_iv,
        tag: row.api_key_tag,
      });
    } catch (err) {
      console.warn(`[admin-api-keys] decrypt failed for provider=${row.provider}: ${err.message}`);
      return '';
    }
  }
  // plaintext (legacy)
  const plaintext = String(row.api_key || '');
  if (plaintext && isEncryptionAvailable()) {
    // Lazy upgrade — schedule encryption in the background so callers are not blocked.
    setImmediate(() => {
      lazyEncryptUpgrade(row.provider, plaintext).catch((err) => {
        console.warn(`[admin-api-keys] lazy upgrade failed for provider=${row.provider}: ${err.message}`);
      });
    });
  }
  return plaintext;
}

async function lazyEncryptUpgrade(provider, plaintext) {
  const enc = encrypt(plaintext);
  if (!enc) return; // key disappeared between checks — give up silently
  await db.query(
    `UPDATE admin_api_keys
        SET api_key = '',
            api_key_encrypted = $2,
            api_key_iv = $3,
            api_key_tag = $4,
            api_key_format = $5,
            updated_at = NOW()
      WHERE provider = $1
        AND api_key_format = $6`,
    [provider, enc.ciphertext, enc.iv, enc.tag, FORMAT_AES_GCM, FORMAT_PLAINTEXT],
  );
  console.log(`[admin-api-keys] lazy-upgraded provider=${provider} to ${FORMAT_AES_GCM}`);
}

async function getAllAdminApiKeys() {
  const { rows } = await db.query(
    `SELECT provider, api_key, api_key_encrypted, api_key_iv, api_key_tag, api_key_format
       FROM admin_api_keys`
  );
  const out = { openai: '', google: '', anthropic: '', openrouter: '' };
  for (const row of rows) {
    out[row.provider] = extractPlaintextFromRow(row) || '';
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

  if (isEncryptionAvailable()) {
    const enc = encrypt(trimmed);
    // encrypt() returns null only when no key is set, but we just checked.
    if (!enc) throw new Error('encryption unavailable');
    // NOTE: api_key column is bound as the empty string '' (param $2) — the
    // plaintext value MUST NOT appear in this statement's bound params.
    await db.query(
      `INSERT INTO admin_api_keys (
         provider, api_key, api_key_encrypted, api_key_iv, api_key_tag, api_key_format,
         updated_by, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (provider) DO UPDATE
         SET api_key            = EXCLUDED.api_key,
             api_key_encrypted  = EXCLUDED.api_key_encrypted,
             api_key_iv         = EXCLUDED.api_key_iv,
             api_key_tag        = EXCLUDED.api_key_tag,
             api_key_format     = EXCLUDED.api_key_format,
             updated_by         = EXCLUDED.updated_by,
             updated_at         = NOW()`,
      [p, '', enc.ciphertext, enc.iv, enc.tag, FORMAT_AES_GCM, adminUserId || null],
    );
    return { provider: p, cleared: false, format: FORMAT_AES_GCM };
  }

  // Dev fallback: no SECRETS_KEY → store plaintext (legacy behavior).
  await db.query(
    `INSERT INTO admin_api_keys (
       provider, api_key, api_key_encrypted, api_key_iv, api_key_tag, api_key_format,
       updated_by, updated_at
     )
     VALUES ($1, $2, NULL, NULL, NULL, $3, $4, NOW())
     ON CONFLICT (provider) DO UPDATE
       SET api_key            = EXCLUDED.api_key,
           api_key_encrypted  = NULL,
           api_key_iv         = NULL,
           api_key_tag        = NULL,
           api_key_format     = EXCLUDED.api_key_format,
           updated_by         = EXCLUDED.updated_by,
           updated_at         = NOW()`,
    [p, trimmed, FORMAT_PLAINTEXT, adminUserId || null],
  );
  return { provider: p, cleared: false, format: FORMAT_PLAINTEXT };
}

module.exports = {
  ALLOWED_PROVIDERS,
  FORMAT_PLAINTEXT,
  FORMAT_AES_GCM,
  normalizeProvider,
  maskApiKey,
  getAllAdminApiKeys,
  getAdminApiKeysMasked,
  setAdminApiKey,
  // exported for tests/scripts
  extractPlaintextFromRow,
  lazyEncryptUpgrade,
};
