'use strict';

// copy-merchant-config
//
// Admin action: copy ALL behaviour-driving data from a SOURCE platform account
// to a DESTINATION account. A merchant who changed her dashboard login gets a
// new users.id; everything is keyed by that stable user_id, so the new account
// is empty. This moves the config + per-customer API keys + learned replies
// across, in a single transaction.
//
// What is copied (in ONE transaction):
//   1. bot_configs.config (JSONB) — UPSERT onto dst (table is UNIQUE(user_id)).
//      API keys are stripped before write — keys never live in this JSONB.
//   2. customer_api_keys rows — UPSERT per (user_id, provider).
//   3. learned_replies rows — UPSERT per (user_id, normalized_question).
//
// HARD CONSTRAINT: never write API keys into bot_configs.config. Keys live ONLY
// in customer_api_keys. We defensively strip key fields from the copied config.

const defaultDb = require('../../db/client');
const { stripApiKeysFromConfigForStorage } = require('../config/api-keys-resolver');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function resolveUserIdByEmail(lookup, email) {
  const clean = normalizeEmail(email);
  if (!clean) return null;
  const r = await lookup.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [clean]);
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Pure, testable core. Copies all merchant data from srcUserId to dstUserId
 * inside a single transaction on the provided `db` (must expose `transaction`).
 *
 * @param {object} db          db client (real src/db/client or a fake)
 * @param {string} srcUserId
 * @param {string} dstUserId
 * @param {object} [opts]
 * @param {string} [opts.adminUserId] recorded as updated_by on copied api keys
 * @returns {Promise<{srcUserId, dstUserId, apiKeysCopied:number, learnedRepliesCopied:number}>}
 */
async function copyMerchantConfig(db, srcUserId, dstUserId, opts = {}) {
  const src = String(srcUserId || '').trim();
  const dst = String(dstUserId || '').trim();
  if (!src) throw new Error('srcUserId required (missing source)');
  if (!dst) throw new Error('dstUserId required (missing destination)');
  if (src === dst) throw new Error('source and destination must differ (src === dst)');

  const adminUserId = opts.adminUserId || null;

  return db.transaction(async (client) => {
    // 1. bot_configs.config — read source, strip any keys, UPSERT onto dst.
    const cfgRes = await client.query(
      'SELECT config, source FROM bot_configs WHERE user_id = $1',
      [src],
    );
    if (!cfgRes.rows[0]) {
      throw new Error('source account has no bot config (not found) — nothing to copy');
    }
    const rawConfig = cfgRes.rows[0].config || {};
    const parsed = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    const safeConfig = stripApiKeysFromConfigForStorage(parsed);
    await client.query(
      `INSERT INTO bot_configs (user_id, config, source)
       VALUES ($1, $2::jsonb, 'admin-copy')
       ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, source = EXCLUDED.source, updated_at = NOW()`,
      [dst, JSON.stringify(safeConfig)],
    );

    // 2. customer_api_keys — copy each provider row (keys stay in this table).
    const keysRes = await client.query(
      `SELECT provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format
         FROM customer_api_keys WHERE user_id = $1`,
      [src],
    );
    for (const k of keysRes.rows) {
      await client.query(
        `INSERT INTO customer_api_keys
           (user_id, provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id, provider) DO UPDATE SET
           api_key_encrypted = EXCLUDED.api_key_encrypted,
           api_key_iv        = EXCLUDED.api_key_iv,
           api_key_tag       = EXCLUDED.api_key_tag,
           api_key_format    = EXCLUDED.api_key_format,
           updated_by        = EXCLUDED.updated_by,
           updated_at        = NOW()`,
        [dst, k.provider, k.api_key_encrypted, k.api_key_iv, k.api_key_tag, k.api_key_format || 'aes-256-gcm', adminUserId],
      );
    }

    // 3. learned_replies — copy each row (UPSERT on (user_id, normalized_question)).
    const learnedRes = await client.query(
      `SELECT question, answer, normalized_question, status
         FROM learned_replies WHERE user_id = $1`,
      [src],
    );
    for (const r of learnedRes.rows) {
      await client.query(
        `INSERT INTO learned_replies (user_id, question, answer, normalized_question, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, normalized_question) DO UPDATE SET
           question = EXCLUDED.question,
           answer   = EXCLUDED.answer,
           status   = EXCLUDED.status`,
        [dst, r.question, r.answer, r.normalized_question, r.status || 'active'],
      );
    }

    return {
      srcUserId: src,
      dstUserId: dst,
      apiKeysCopied: keysRes.rows.length,
      learnedRepliesCopied: learnedRes.rows.length,
    };
  });
}

/**
 * Thin wrapper: resolve both accounts by email → user_id, validate, then copy.
 * Uses the shared db client.
 */
async function copyMerchantConfigByEmail(srcEmail, dstEmail, opts = {}) {
  const db = opts.db || defaultDb;
  const cleanSrc = normalizeEmail(srcEmail);
  const cleanDst = normalizeEmail(dstEmail);
  if (!cleanSrc) throw new Error('source email required');
  if (!cleanDst) throw new Error('destination email required');

  const srcUserId = await resolveUserIdByEmail(db, cleanSrc);
  if (!srcUserId) throw new Error('source account not found (المصدر غير موجود)');
  const dstUserId = await resolveUserIdByEmail(db, cleanDst);
  if (!dstUserId) throw new Error('destination account not found (الوجهة غير موجودة)');
  if (srcUserId === dstUserId) {
    throw new Error('source and destination are the same account (identical)');
  }

  return copyMerchantConfig(db, srcUserId, dstUserId, opts);
}

module.exports = {
  copyMerchantConfig,
  copyMerchantConfigByEmail,
  resolveUserIdByEmail,
  normalizeEmail,
};
