'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  encodeToken,
  decodeToken,
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
