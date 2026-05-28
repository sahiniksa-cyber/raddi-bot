'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Configure encryption key BEFORE loading service module.
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

// Inject a fake db client by populating require.cache for the actual module
// path that customer-api-keys.js requires.
const dbClientPath = require.resolve('../src/db/client');
const captured = { queries: [], rows: [] };
const fakeDb = {
  query: async (text, params = []) => {
    captured.queries.push({ text, params });
    if (/^\s*SELECT/i.test(text)) {
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

delete require.cache[require.resolve('../src/services/admin/customer-api-keys')];
const customerKeys = require('../src/services/admin/customer-api-keys');

const UID = '11111111-1111-1111-1111-111111111111';

test('setCustomerApiKey encrypts (AES-GCM) and writes an INSERT … ON CONFLICT row', async () => {
  captured.queries = [];
  captured.rows = [];
  const result = await customerKeys.setCustomerApiKey({
    userId: UID,
    provider: 'openai',
    apiKey: 'sk-customer-secret-abcdef1234',
    adminUserId: 'admin-1',
  });
  assert.equal(result.userId, UID);
  assert.equal(result.provider, 'openai');
  assert.equal(result.cleared, false);
  assert.equal(result.format, 'aes-256-gcm');

  const insert = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));
  assert.ok(insert, 'expected an INSERT statement');
  assert.ok(/ON CONFLICT \(user_id, provider\)/i.test(insert.text), 'expected ON CONFLICT clause');

  // Plaintext must NOT appear in bound params.
  const flat = JSON.stringify(insert.params);
  assert.ok(
    !flat.includes('sk-customer-secret-abcdef1234'),
    `plaintext key leaked into DB params: ${flat}`,
  );

  // params: [userId, provider, ciphertext, iv, tag, format, adminId]
  assert.equal(insert.params[0], UID);
  assert.equal(insert.params[1], 'openai');
  assert.ok(insert.params[2] && insert.params[2].length > 0, 'ciphertext is empty');
  assert.equal(insert.params[5], 'aes-256-gcm');
  assert.equal(insert.params[6], 'admin-1');
});

test('setCustomerApiKey with empty apiKey deletes the row', async () => {
  captured.queries = [];
  const result = await customerKeys.setCustomerApiKey({
    userId: UID,
    provider: 'openai',
    apiKey: '   ',
    adminUserId: 'admin-1',
  });
  assert.equal(result.cleared, true);
  const del = captured.queries.find(q => /DELETE FROM customer_api_keys/i.test(q.text));
  assert.ok(del, 'expected a DELETE statement');
  assert.deepEqual(del.params, [UID, 'openai']);
});

test('getCustomerApiKey round-trips: encrypt → store → decrypt to plaintext', async () => {
  captured.queries = [];
  captured.rows = [];
  await customerKeys.setCustomerApiKey({
    userId: UID,
    provider: 'google',
    apiKey: 'AIzaSyTestRoundTrip-xyz-9876',
    adminUserId: 'admin-1',
  });
  const insert = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));
  captured.rows = [{
    provider: 'google',
    api_key_encrypted: insert.params[2],
    api_key_iv: insert.params[3],
    api_key_tag: insert.params[4],
    api_key_format: 'aes-256-gcm',
  }];

  const plaintext = await customerKeys.getCustomerApiKey({ userId: UID, provider: 'google' });
  assert.equal(plaintext, 'AIzaSyTestRoundTrip-xyz-9876');
});

test('getCustomerApiKey returns null when no row exists', async () => {
  captured.rows = [];
  const result = await customerKeys.getCustomerApiKey({ userId: UID, provider: 'openai' });
  assert.equal(result, null);
});

test('getCustomerApiKeysFor returns plaintext map for every present provider', async () => {
  captured.queries = [];
  captured.rows = [];
  await customerKeys.setCustomerApiKey({
    userId: UID, provider: 'openai', apiKey: 'sk-openai-customer-1234567890', adminUserId: null,
  });
  const insert1 = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));

  captured.queries = [];
  await customerKeys.setCustomerApiKey({
    userId: UID, provider: 'anthropic', apiKey: 'sk-ant-customer-9999', adminUserId: null,
  });
  const insert2 = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));

  captured.rows = [
    {
      provider: 'openai',
      api_key_encrypted: insert1.params[2],
      api_key_iv: insert1.params[3],
      api_key_tag: insert1.params[4],
      api_key_format: 'aes-256-gcm',
    },
    {
      provider: 'anthropic',
      api_key_encrypted: insert2.params[2],
      api_key_iv: insert2.params[3],
      api_key_tag: insert2.params[4],
      api_key_format: 'aes-256-gcm',
    },
  ];

  const all = await customerKeys.getCustomerApiKeysFor(UID);
  assert.equal(all.openai, 'sk-openai-customer-1234567890');
  assert.equal(all.anthropic, 'sk-ant-customer-9999');
  assert.equal(all.google, '');
  assert.equal(all.openrouter, '');
});

test('getCustomerApiKeysMaskedFor returns masked + hasKey shape', async () => {
  captured.queries = [];
  await customerKeys.setCustomerApiKey({
    userId: UID, provider: 'openai', apiKey: 'sk-proj-abcdefghijklmnop', adminUserId: null,
  });
  const insert = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));
  captured.rows = [{
    provider: 'openai',
    api_key_encrypted: insert.params[2],
    api_key_iv: insert.params[3],
    api_key_tag: insert.params[4],
    api_key_format: 'aes-256-gcm',
    updated_at: new Date('2026-05-28T00:00:00Z'),
  }];

  const masked = await customerKeys.getCustomerApiKeysMaskedFor(UID);
  assert.equal(masked.openai.hasKey, true);
  assert.equal(masked.openai.masked, 'sk-proj-••••mnop');
  assert.ok(masked.openai.updated_at);
  assert.equal(masked.google.hasKey, false);
  assert.equal(masked.google.masked, null);
});

test('dev fallback: when SECRETS_KEY is absent, set/get still works without throwing', async () => {
  const previous = process.env.SECRETS_KEY;
  delete process.env.SECRETS_KEY;
  try {
    captured.queries = [];
    const result = await customerKeys.setCustomerApiKey({
      userId: UID, provider: 'openrouter', apiKey: 'or-dev-plain-12345', adminUserId: null,
    });
    assert.equal(result.cleared, false);
    assert.equal(result.format, 'plaintext_inline');

    const insert = captured.queries.find(q => /INSERT INTO customer_api_keys/i.test(q.text));
    assert.ok(insert, 'expected an INSERT statement in dev mode');
    // In dev fallback the plaintext lives in api_key_encrypted (param[2])
    // because the table has no separate plaintext column.
    // Dev SQL bind order: [userId, provider, plaintext, format, adminUserId].
    assert.equal(insert.params[2], 'or-dev-plain-12345');
    assert.equal(insert.params[3], 'plaintext_inline');

    captured.rows = [{
      provider: 'openrouter',
      api_key_encrypted: 'or-dev-plain-12345',
      api_key_iv: null,
      api_key_tag: null,
      api_key_format: 'plaintext_inline',
    }];
    const plaintext = await customerKeys.getCustomerApiKey({ userId: UID, provider: 'openrouter' });
    assert.equal(plaintext, 'or-dev-plain-12345');
  } finally {
    if (previous) process.env.SECRETS_KEY = previous;
  }
});

test('resolveEffectiveApiKeys: customer key wins over admin key', () => {
  const { resolveEffectiveApiKeys } = require('../src/services/config/api-keys-resolver');
  const merged = resolveEffectiveApiKeys({
    userId: UID,
    customerConfig: { model: 'gpt-4o-mini' },
    adminKeys:    { openai: 'admin-openai',    google: 'admin-google', anthropic: '', openrouter: '' },
    customerKeys: { openai: 'customer-openai', google: '',             anthropic: '', openrouter: '' },
  });
  assert.equal(merged.openaiApiKey, 'customer-openai');
  assert.equal(merged.googleApiKey, 'admin-google');
  assert.equal(merged.model, 'gpt-4o-mini');
});

test('resolveEffectiveApiKeys: falls back to admin key when customer key is empty', () => {
  const { resolveEffectiveApiKeys } = require('../src/services/config/api-keys-resolver');
  const merged = resolveEffectiveApiKeys({
    userId: UID,
    customerConfig: {},
    adminKeys:    { openai: 'admin-openai', google: '', anthropic: '', openrouter: '' },
    customerKeys: { openai: '',             google: '', anthropic: '', openrouter: '' },
  });
  assert.equal(merged.openaiApiKey, 'admin-openai');
});

test('resolveEffectiveApiKeys: legacy customerConfig key beats admin but loses to customerKeys', () => {
  const { resolveEffectiveApiKeys } = require('../src/services/config/api-keys-resolver');
  const merged = resolveEffectiveApiKeys({
    userId: UID,
    customerConfig: { openaiApiKey: 'legacy-key' },
    adminKeys:    { openai: 'admin-openai',    google: '', anthropic: '', openrouter: '' },
    customerKeys: { openai: 'customer-openai', google: '', anthropic: '', openrouter: '' },
  });
  assert.equal(merged.openaiApiKey, 'customer-openai');

  const merged2 = resolveEffectiveApiKeys({
    userId: UID,
    customerConfig: { openaiApiKey: 'legacy-key' },
    adminKeys:    { openai: 'admin-openai', google: '', anthropic: '', openrouter: '' },
    customerKeys: { openai: '',             google: '', anthropic: '', openrouter: '' },
  });
  assert.equal(merged2.openaiApiKey, 'legacy-key');
});
