'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stores = require('../src/services/salla/salla-stores');

// In-memory fake of the salla_stores table that understands only the exact
// queries the module issues (upsert / select-by-merchant / mark-uninstalled).
function fakeDb() {
  const rows = new Map();
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (/INSERT INTO salla_stores/.test(sql)) {
        const [merchant_id, store_name, aEnc, aIv, aTag, aPlain,
          rEnc, rIv, rTag, rPlain, expiresAt, scope] = params;
        const prev = rows.get(merchant_id) || {};
        rows.set(merchant_id, {
          ...prev,
          merchant_id,
          store_name: store_name || prev.store_name || null,
          access_token_encrypted: aEnc, access_token_iv: aIv, access_token_tag: aTag, access_token_plain: aPlain,
          refresh_token_encrypted: rEnc, refresh_token_iv: rIv, refresh_token_tag: rTag, refresh_token_plain: rPlain,
          token_expires_at: expiresAt, scope, status: 'authorized', uninstalled_at: null,
        });
        return { rows: [{ id: 'row-' + merchant_id, merchant_id }], rowCount: 1 };
      }
      if (/SELECT \* FROM salla_stores WHERE merchant_id/.test(sql)) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE salla_stores SET status='uninstalled'/.test(sql)) {
        const row = rows.get(params[0]);
        if (row) {
          row.status = 'uninstalled';
          row.access_token_encrypted = null; row.access_token_plain = null;
          row.refresh_token_encrypted = null; row.refresh_token_plain = null;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Reversible fake so we can assert values are encrypted at rest, not stored raw.
const fakeSecrets = {
  isEncryptionAvailable: () => true,
  encrypt: (pt) => ({ ciphertext: 'ENC(' + pt + ')', iv: 'iv', tag: 'tag' }),
  decrypt: ({ ciphertext }) => ciphertext.slice(4, -1),
};

const plaintextSecrets = { isEncryptionAvailable: () => false };

test('encrypts tokens at rest and reads them back', async () => {
  const database = fakeDb();
  const deps = { database, secrets: fakeSecrets };
  await stores.upsertStoreAuthorization('42', {
    accessToken: 'ACCESS', refreshToken: 'REFRESH', scope: 'orders.read', storeName: 'متجري',
  }, deps);

  const row = (await database.query('SELECT * FROM salla_stores WHERE merchant_id = $1', ['42'])).rows[0];
  assert.equal(row.access_token_encrypted, 'ENC(ACCESS)');
  assert.equal(row.access_token_plain, null, 'raw access token must not be persisted');
  assert.equal(row.refresh_token_encrypted, 'ENC(REFRESH)');

  assert.equal(await stores.getAccessToken('42', deps), 'ACCESS');
  assert.equal(await stores.getRefreshToken('42', deps), 'REFRESH');
});

test('falls back to plaintext when encryption is unavailable (dev)', async () => {
  const database = fakeDb();
  const deps = { database, secrets: plaintextSecrets };
  await stores.upsertStoreAuthorization('7', { accessToken: 'AAA', refreshToken: 'RRR' }, deps);
  const row = (await database.query('SELECT * FROM salla_stores WHERE merchant_id = $1', ['7'])).rows[0];
  assert.equal(row.access_token_plain, 'AAA');
  assert.equal(row.access_token_encrypted, null);
  assert.equal(await stores.getAccessToken('7', deps), 'AAA');
});

test('getAccessToken returns null for an unknown merchant', async () => {
  const database = fakeDb();
  assert.equal(await stores.getAccessToken('nope', { database, secrets: fakeSecrets }), null);
});

test('markUninstalled clears tokens and flips status', async () => {
  const database = fakeDb();
  const deps = { database, secrets: fakeSecrets };
  await stores.upsertStoreAuthorization('9', { accessToken: 'A', refreshToken: 'R' }, deps);
  await stores.markUninstalled('9', deps);
  const store = await stores.getStore('9', deps);
  assert.equal(store.status, 'uninstalled');
  assert.equal(await stores.getAccessToken('9', deps), null);
});

test('re-authorizing the same merchant updates the token', async () => {
  const database = fakeDb();
  const deps = { database, secrets: fakeSecrets };
  await stores.upsertStoreAuthorization('5', { accessToken: 'OLD', refreshToken: 'r1' }, deps);
  await stores.upsertStoreAuthorization('5', { accessToken: 'NEW', refreshToken: 'r2' }, deps);
  assert.equal(await stores.getAccessToken('5', deps), 'NEW');
  assert.equal(await stores.getRefreshToken('5', deps), 'r2');
});
