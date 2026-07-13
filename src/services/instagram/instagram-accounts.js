'use strict';

/**
 * Instagram account store. Persists one connected Instagram professional
 * account per platform user in `instagram_accounts`, with the long-lived
 * access token encrypted at rest (AES-256-GCM) via the shared secrets module.
 * Falls back to plaintext storage in dev when SECRETS_KEY is absent — mirrors
 * the existing customer_api_keys behaviour.
 *
 * Isolation: this module only touches instagram_* tables. It never imports
 * Baileys or any WhatsApp code.
 */

const db = require('../../db/client');
const defaultSecrets = require('../security/secrets');

function encodeToken(token, { secrets = defaultSecrets } = {}) {
  if (secrets.isEncryptionAvailable()) {
    const { ciphertext, iv, tag } = secrets.encrypt(token);
    return {
      access_token_encrypted: ciphertext,
      access_token_iv: iv,
      access_token_tag: tag,
      access_token_plain: null,
    };
  }
  return {
    access_token_encrypted: null,
    access_token_iv: null,
    access_token_tag: null,
    access_token_plain: token,
  };
}

function decodeToken(row, { secrets = defaultSecrets } = {}) {
  if (!row) return null;
  if (row.access_token_encrypted) {
    return secrets.decrypt({
      ciphertext: row.access_token_encrypted,
      iv: row.access_token_iv,
      tag: row.access_token_tag,
    });
  }
  return row.access_token_plain || null;
}

async function upsertAccount(userId, { igUserId, igUsername, token, expiresAt }, deps = {}) {
  const database = deps.database || db;
  const t = encodeToken(token, deps);
  const res = await database.query(
    `INSERT INTO instagram_accounts
       (user_id, ig_user_id, ig_username, access_token_encrypted, access_token_iv,
        access_token_tag, access_token_plain, token_expires_at, status, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'connected',NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       ig_user_id=EXCLUDED.ig_user_id, ig_username=EXCLUDED.ig_username,
       access_token_encrypted=EXCLUDED.access_token_encrypted, access_token_iv=EXCLUDED.access_token_iv,
       access_token_tag=EXCLUDED.access_token_tag, access_token_plain=EXCLUDED.access_token_plain,
       token_expires_at=EXCLUDED.token_expires_at, status='connected', connected_at=NOW()
     RETURNING id`,
    [userId, igUserId, igUsername, t.access_token_encrypted, t.access_token_iv,
      t.access_token_tag, t.access_token_plain, expiresAt],
  );
  return res.rows[0];
}

async function getAccount(userId, deps = {}) {
  const database = deps.database || db;
  const res = await database.query('SELECT * FROM instagram_accounts WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function getAccountToken(userId, deps = {}) {
  const row = await getAccount(userId, deps);
  return decodeToken(row, deps);
}

async function findUserIdByIgAccount(igUserId, deps = {}) {
  const database = deps.database || db;
  const res = await database.query(
    `SELECT user_id FROM instagram_accounts WHERE ig_user_id = $1 AND status = 'connected'`,
    [igUserId],
  );
  return res.rows[0] ? res.rows[0].user_id : null;
}

async function disconnectAccount(userId, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `UPDATE instagram_accounts
       SET status='disconnected', access_token_encrypted=NULL, access_token_iv=NULL,
           access_token_tag=NULL, access_token_plain=NULL
     WHERE user_id=$1`,
    [userId],
  );
}

async function listConnectedAccounts(deps = {}) {
  const database = deps.database || db;
  const res = await database.query(`SELECT * FROM instagram_accounts WHERE status='connected'`);
  return res.rows;
}

// Corrects the stored ig_user_id for a merchant. Used to self-heal when the id
// Meta sends in the webhook (entry.id) differs from the profile.user_id captured
// at OAuth time — ig_user_id is ONLY used to route inbound webhooks, so aligning
// it to what Meta actually sends is safe and makes future lookups match directly.
async function setIgUserId(userId, igUserId, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `UPDATE instagram_accounts SET ig_user_id = $2 WHERE user_id = $1`,
    [userId, igUserId],
  );
}

module.exports = {
  encodeToken,
  decodeToken,
  upsertAccount,
  getAccount,
  getAccountToken,
  findUserIdByIgAccount,
  disconnectAccount,
  listConnectedAccounts,
  setIgUserId,
};
