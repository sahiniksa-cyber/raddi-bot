'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  encodeToken,
  decodeToken,
  findUserIdByIgAccount,
} = require('../src/services/instagram/instagram-accounts');

test('encodeToken uses secrets.encrypt when available', () => {
  const fakeSecrets = {
    isEncryptionAvailable: () => true,
    encrypt: (pt) => ({ ciphertext: 'C:' + pt, iv: 'IV', tag: 'TAG' }),
  };
  const row = encodeToken('tok123', { secrets: fakeSecrets });
  assert.deepStrictEqual(row, {
    access_token_encrypted: 'C:tok123',
    access_token_iv: 'IV',
    access_token_tag: 'TAG',
    access_token_plain: null,
  });
});

test('encodeToken falls back to plaintext when encryption unavailable', () => {
  const fakeSecrets = { isEncryptionAvailable: () => false };
  const row = encodeToken('tok123', { secrets: fakeSecrets });
  assert.strictEqual(row.access_token_plain, 'tok123');
  assert.strictEqual(row.access_token_encrypted, null);
});

test('decodeToken round-trips encrypted', () => {
  const fakeSecrets = { decrypt: ({ ciphertext }) => ciphertext.replace('C:', '') };
  const tok = decodeToken(
    {
      access_token_encrypted: 'C:tok123',
      access_token_iv: 'IV',
      access_token_tag: 'TAG',
      access_token_plain: null,
    },
    { secrets: fakeSecrets },
  );
  assert.strictEqual(tok, 'tok123');
});

test('decodeToken returns plaintext fallback when not encrypted', () => {
  const tok = decodeToken({ access_token_encrypted: null, access_token_plain: 'plain' }, {});
  assert.strictEqual(tok, 'plain');
});

test('decodeToken null-safe on missing row', () => {
  assert.strictEqual(decodeToken(null, {}), null);
});

// ── Multi-tenant routing isolation (Phase 4 — critical: no cross-store mixing) ──
test('findUserIdByIgAccount routes two different IG accounts to their own merchants', async () => {
  const rows = {
    IG_A: { user_id: 'store-A' },
    IG_B: { user_id: 'store-B' },
  };
  const seen = [];
  const database = {
    query: async (sql, params) => {
      seen.push({ sql, params });
      const igId = params[0];
      const row = rows[igId];
      // The query must filter on BOTH ig_user_id AND status='connected'.
      return { rows: row ? [row] : [] };
    },
  };
  assert.strictEqual(await findUserIdByIgAccount('IG_A', { database }), 'store-A');
  assert.strictEqual(await findUserIdByIgAccount('IG_B', { database }), 'store-B');
  // Never leak one store's id into the other's lookup.
  assert.notStrictEqual(await findUserIdByIgAccount('IG_A', { database }), 'store-B');
  // Guards against a regression that drops the connected-status filter.
  assert.ok(seen.every((c) => /status\s*=\s*'connected'/.test(c.sql)));
  assert.ok(seen.every((c) => /ig_user_id\s*=\s*\$1/.test(c.sql)));
});

test('findUserIdByIgAccount returns null for an unknown or disconnected account (never a wrong merchant)', async () => {
  const database = { query: async () => ({ rows: [] }) };
  assert.strictEqual(await findUserIdByIgAccount('UNKNOWN_IG', { database }), null);
});
