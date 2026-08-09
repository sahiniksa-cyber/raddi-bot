'use strict';

/**
 * Salla store credential store. Persists one row per Salla merchant in
 * `salla_stores`, with the OAuth access_token AND refresh_token encrypted at
 * rest (AES-256-GCM) via the shared secrets module. Falls back to plaintext in
 * dev when SECRETS_KEY is absent — mirrors instagram-accounts / customer_api_keys.
 *
 * "Easy Mode" flow: when a merchant installs the Raddi app, Salla POSTs the
 * `app.store.authorize` webhook carrying the tokens; the route hands them here.
 * The stored token is what later lets the AI read the merchant's store data
 * (products, orders, customers) from the Salla Admin API.
 *
 * Keyed by Salla `merchant_id` (not the platform user) because the authorize
 * webhook arrives with no logged-in session. `user_id` is linked separately
 * (nullable) once we know which Raddi account the store belongs to.
 */

const db = require('../../db/client');
const defaultSecrets = require('../security/secrets');

function encodeSecret(value, { secrets = defaultSecrets } = {}) {
  if (value && secrets.isEncryptionAvailable()) {
    const { ciphertext, iv, tag } = secrets.encrypt(value);
    return { enc: ciphertext, iv, tag, plain: null };
  }
  return { enc: null, iv: null, tag: null, plain: value || null };
}

function decodeSecret({ enc, iv, tag, plain }, { secrets = defaultSecrets } = {}) {
  if (enc) return secrets.decrypt({ ciphertext: enc, iv, tag });
  return plain || null;
}

async function upsertStoreAuthorization(merchantId, { accessToken, refreshToken, expiresAt, scope, storeName } = {}, deps = {}) {
  const database = deps.database || db;
  const a = encodeSecret(accessToken, deps);
  const r = encodeSecret(refreshToken, deps);
  const res = await database.query(
    `INSERT INTO salla_stores
       (merchant_id, store_name,
        access_token_encrypted, access_token_iv, access_token_tag, access_token_plain,
        refresh_token_encrypted, refresh_token_iv, refresh_token_tag, refresh_token_plain,
        token_expires_at, scope, status, installed_at, uninstalled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'authorized',NOW(),NULL)
     ON CONFLICT (merchant_id) DO UPDATE SET
       store_name=COALESCE(EXCLUDED.store_name, salla_stores.store_name),
       access_token_encrypted=EXCLUDED.access_token_encrypted, access_token_iv=EXCLUDED.access_token_iv,
       access_token_tag=EXCLUDED.access_token_tag, access_token_plain=EXCLUDED.access_token_plain,
       refresh_token_encrypted=EXCLUDED.refresh_token_encrypted, refresh_token_iv=EXCLUDED.refresh_token_iv,
       refresh_token_tag=EXCLUDED.refresh_token_tag, refresh_token_plain=EXCLUDED.refresh_token_plain,
       token_expires_at=EXCLUDED.token_expires_at, scope=EXCLUDED.scope,
       status='authorized', installed_at=COALESCE(salla_stores.installed_at, NOW()),
       uninstalled_at=NULL, updated_at=NOW()
     RETURNING id, merchant_id`,
    [String(merchantId), storeName || null,
      a.enc, a.iv, a.tag, a.plain,
      r.enc, r.iv, r.tag, r.plain,
      expiresAt || null, scope || null],
  );
  return res.rows[0];
}

async function getStore(merchantId, deps = {}) {
  const database = deps.database || db;
  const res = await database.query('SELECT * FROM salla_stores WHERE merchant_id = $1', [String(merchantId)]);
  return res.rows[0] || null;
}

async function getAccessToken(merchantId, deps = {}) {
  const row = await getStore(merchantId, deps);
  if (!row) return null;
  return decodeSecret(
    { enc: row.access_token_encrypted, iv: row.access_token_iv, tag: row.access_token_tag, plain: row.access_token_plain },
    deps,
  );
}

async function getRefreshToken(merchantId, deps = {}) {
  const row = await getStore(merchantId, deps);
  if (!row) return null;
  return decodeSecret(
    { enc: row.refresh_token_encrypted, iv: row.refresh_token_iv, tag: row.refresh_token_tag, plain: row.refresh_token_plain },
    deps,
  );
}

async function markUninstalled(merchantId, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `UPDATE salla_stores SET status='uninstalled', uninstalled_at=NOW(),
       access_token_encrypted=NULL, access_token_iv=NULL, access_token_tag=NULL, access_token_plain=NULL,
       refresh_token_encrypted=NULL, refresh_token_iv=NULL, refresh_token_tag=NULL, refresh_token_plain=NULL,
       updated_at=NOW()
     WHERE merchant_id=$1`,
    [String(merchantId)],
  );
}

async function listStores(deps = {}) {
  const database = deps.database || db;
  const res = await database.query(
    `SELECT merchant_id, store_name, status, token_expires_at, user_id, installed_at
       FROM salla_stores ORDER BY installed_at DESC NULLS LAST`,
  );
  return res.rows;
}

async function linkUser(merchantId, userId, deps = {}) {
  const database = deps.database || db;
  await database.query(
    'UPDATE salla_stores SET user_id=$2, updated_at=NOW() WHERE merchant_id=$1',
    [String(merchantId), userId],
  );
}

module.exports = {
  encodeSecret,
  decodeSecret,
  upsertStoreAuthorization,
  getStore,
  getAccessToken,
  getRefreshToken,
  markUninstalled,
  listStores,
  linkUser,
};
