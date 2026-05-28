'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Configure encryption key BEFORE loading service module.
process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');

// Inject a fake db client by populating require.cache for the actual module
// path that admin-api-keys.js requires.
const dbClientPath = require.resolve('../src/db/client');
const captured = { queries: [] };
const fakeDb = {
  query: async (text, params = []) => {
    captured.queries.push({ text, params });
    // SELECT after INSERT not needed; service does not read back.
    if (/^SELECT/i.test(text.trim())) {
      // Return whatever the in-memory store has.
      return { rows: captured.rows || [] };
    }
    return { rows: [] };
  },
  transaction: async (fn) => fn({ query: fakeDb.query }),
  withClient: async (fn) => fn({ query: fakeDb.query }),
};
require.cache[dbClientPath] = {
  id: dbClientPath,
  filename: dbClientPath,
  loaded: true,
  exports: fakeDb,
};

// Now load the service.
delete require.cache[require.resolve('../src/services/admin/admin-api-keys')];
const adminKeys = require('../src/services/admin/admin-api-keys');

test('setAdminApiKey stores AES-256-GCM ciphertext and clears plaintext column when key is set', async () => {
  captured.queries = [];
  const result = await adminKeys.setAdminApiKey('openai', 'sk-secret-supersecretkey-xyz', 'admin-user-1');
  assert.equal(result.provider, 'openai');
  assert.equal(result.cleared, false);
  assert.equal(result.format, 'aes-256-gcm');

  // Find the INSERT.
  const insert = captured.queries.find(q => /INSERT INTO admin_api_keys/i.test(q.text));
  assert.ok(insert, 'expected an INSERT statement');

  // The plaintext value must NOT appear anywhere in the bound params.
  const flat = JSON.stringify(insert.params);
  assert.ok(
    !flat.includes('sk-secret-supersecretkey-xyz'),
    `plaintext key leaked into DB params: ${flat}`,
  );

  // The api_key column (params[1] per our SQL) must be the empty string
  // (or null) — never the plaintext.
  assert.equal(insert.params[1], '', 'api_key column must be empty when encryption is used');

  // The encrypted ciphertext column must be present.
  assert.ok(insert.params[2] && insert.params[2].length > 0, 'ciphertext is empty');
});

test('setAdminApiKey with empty key deletes the row', async () => {
  captured.queries = [];
  const result = await adminKeys.setAdminApiKey('openai', '   ', 'admin-1');
  assert.equal(result.cleared, true);
  assert.ok(captured.queries.some(q => /DELETE FROM admin_api_keys/i.test(q.text)));
});

test('getAllAdminApiKeys decrypts AES-256-GCM rows back to plaintext', async () => {
  // Round-trip via the same service: encrypt → store in fake → read back.
  captured.queries = [];
  await adminKeys.setAdminApiKey('google', 'AIzaTestKey-roundtrip-12345', 'admin-1');
  const insert = captured.queries.find(q => /INSERT INTO admin_api_keys/i.test(q.text));
  const stored = {
    provider: 'google',
    api_key: '',
    api_key_encrypted: insert.params[2],
    api_key_iv: insert.params[3],
    api_key_tag: insert.params[4],
    api_key_format: 'aes-256-gcm',
  };
  captured.rows = [stored];

  const all = await adminKeys.getAllAdminApiKeys();
  assert.equal(all.google, 'AIzaTestKey-roundtrip-12345');
  assert.equal(all.openai, '');
});

test('getAllAdminApiKeys still works with legacy plaintext rows (backward compatible)', async () => {
  captured.rows = [
    { provider: 'anthropic', api_key: 'sk-ant-legacy-plain', api_key_format: 'plaintext' },
  ];
  const all = await adminKeys.getAllAdminApiKeys();
  assert.equal(all.anthropic, 'sk-ant-legacy-plain');
});
