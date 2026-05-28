'use strict';

/**
 * customer-api-keys
 *
 * Per-customer API keys that override the platform-wide admin keys for a
 * given user_id. Mirrors the shape of `admin-api-keys.js`:
 *   - AES-256-GCM at-rest encryption when SECRETS_KEY is set
 *   - Plaintext-inline fallback in dev (no api_key column — value is stored
 *     in api_key_encrypted with format='plaintext_inline' for clarity).
 *
 * Frontend-facing reads MUST go through `getCustomerApiKeysMaskedFor` —
 * plaintext is only ever returned by `getCustomerApiKey(...)` to the
 * runtime resolver, never to a HTTP response.
 */

const db = require('../../db/client');
const { encrypt, decrypt, isEncryptionAvailable } = require('../security/secrets');
const { maskApiKey, normalizeProvider } = require('./admin-api-keys');

const VALID_PROVIDERS = ['openai', 'google', 'anthropic', 'openrouter'];
const FORMAT_AES_GCM = 'aes-256-gcm';
const FORMAT_PLAINTEXT_INLINE = 'plaintext_inline';

function extractPlaintextFromRow(row) {
  if (!row) return '';
  const format = row.api_key_format || FORMAT_PLAINTEXT_INLINE;
  if (format === FORMAT_AES_GCM) {
    if (!row.api_key_encrypted || !row.api_key_iv || !row.api_key_tag) return '';
    try {
      return decrypt({
        ciphertext: row.api_key_encrypted,
        iv: row.api_key_iv,
        tag: row.api_key_tag,
      });
    } catch (err) {
      console.warn(`[customer-api-keys] decrypt failed for provider=${row.provider}: ${err.message}`);
      return '';
    }
  }
  // plaintext_inline (dev fallback): value sits inside api_key_encrypted as-is.
  return String(row.api_key_encrypted || '');
}

async function setCustomerApiKey({ userId, provider, apiKey, adminUserId }) {
  if (!userId) throw new Error('userId مطلوب');
  const p = normalizeProvider(provider);
  const trimmed = String(apiKey || '').trim();

  if (!trimmed) {
    await db.query(
      'DELETE FROM customer_api_keys WHERE user_id = $1 AND provider = $2',
      [userId, p],
    );
    return { userId, provider: p, cleared: true };
  }

  if (isEncryptionAvailable()) {
    const enc = encrypt(trimmed);
    if (!enc) throw new Error('encryption unavailable');
    await db.query(
      `INSERT INTO customer_api_keys (
         user_id, provider, api_key_encrypted, api_key_iv, api_key_tag,
         api_key_format, updated_by, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
         SET api_key_encrypted = EXCLUDED.api_key_encrypted,
             api_key_iv        = EXCLUDED.api_key_iv,
             api_key_tag       = EXCLUDED.api_key_tag,
             api_key_format    = EXCLUDED.api_key_format,
             updated_by        = EXCLUDED.updated_by,
             updated_at        = NOW()`,
      [userId, p, enc.ciphertext, enc.iv, enc.tag, FORMAT_AES_GCM, adminUserId || null],
    );
    return { userId, provider: p, cleared: false, format: FORMAT_AES_GCM };
  }

  // Dev fallback: no SECRETS_KEY → stash plaintext inside api_key_encrypted.
  // (no separate `api_key` column on this table — keeps schema lean.)
  await db.query(
    `INSERT INTO customer_api_keys (
       user_id, provider, api_key_encrypted, api_key_iv, api_key_tag,
       api_key_format, updated_by, updated_at
     )
     VALUES ($1, $2, $3, NULL, NULL, $4, $5, NOW())
     ON CONFLICT (user_id, provider) DO UPDATE
       SET api_key_encrypted = EXCLUDED.api_key_encrypted,
           api_key_iv        = NULL,
           api_key_tag       = NULL,
           api_key_format    = EXCLUDED.api_key_format,
           updated_by        = EXCLUDED.updated_by,
           updated_at        = NOW()`,
    [userId, p, trimmed, FORMAT_PLAINTEXT_INLINE, adminUserId || null],
  );
  return { userId, provider: p, cleared: false, format: FORMAT_PLAINTEXT_INLINE };
}

async function getCustomerApiKey({ userId, provider }) {
  if (!userId) return null;
  const p = normalizeProvider(provider);
  const { rows } = await db.query(
    `SELECT provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format
       FROM customer_api_keys
      WHERE user_id = $1 AND provider = $2`,
    [userId, p],
  );
  if (!rows.length) return null;
  const plaintext = extractPlaintextFromRow(rows[0]);
  return plaintext || null;
}

async function getCustomerApiKeysFor(userId) {
  const out = { openai: '', google: '', anthropic: '', openrouter: '' };
  if (!userId) return out;
  const { rows } = await db.query(
    `SELECT provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format
       FROM customer_api_keys
      WHERE user_id = $1`,
    [userId],
  );
  for (const row of rows) {
    if (!VALID_PROVIDERS.includes(row.provider)) continue;
    out[row.provider] = extractPlaintextFromRow(row) || '';
  }
  return out;
}

async function getCustomerApiKeysMaskedFor(userId) {
  const out = {
    openai:     { masked: null, hasKey: false, updated_at: null },
    google:     { masked: null, hasKey: false, updated_at: null },
    anthropic:  { masked: null, hasKey: false, updated_at: null },
    openrouter: { masked: null, hasKey: false, updated_at: null },
  };
  if (!userId) return out;
  const { rows } = await db.query(
    `SELECT provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format, updated_at
       FROM customer_api_keys
      WHERE user_id = $1`,
    [userId],
  );
  for (const row of rows) {
    if (!VALID_PROVIDERS.includes(row.provider)) continue;
    const plaintext = extractPlaintextFromRow(row);
    out[row.provider] = {
      masked: maskApiKey(plaintext),
      hasKey: Boolean(plaintext),
      updated_at: row.updated_at || null,
    };
  }
  return out;
}

async function deleteCustomerApiKey({ userId, provider, adminUserId }) {
  return setCustomerApiKey({ userId, provider, apiKey: '', adminUserId });
}

module.exports = {
  VALID_PROVIDERS,
  FORMAT_AES_GCM,
  FORMAT_PLAINTEXT_INLINE,
  setCustomerApiKey,
  getCustomerApiKey,
  getCustomerApiKeysFor,
  getCustomerApiKeysMaskedFor,
  deleteCustomerApiKey,
  // exported for tests
  extractPlaintextFromRow,
};
