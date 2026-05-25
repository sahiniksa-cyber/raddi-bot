'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminApiKeysHandlers } = require('../src/routes/admin.routes');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

test('GET /api/admin/api-keys returns masked keys', async () => {
  const deps = {
    getAdminApiKeysMasked: async () => ({
      openai: 'sk-proj-••••mnop',
      google: 'AIza••••OpQr',
      anthropic: null,
      openrouter: null,
    }),
  };
  const { getApiKeys } = createAdminApiKeysHandlers(deps);
  const res = fakeRes();
  await getApiKeys({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    keys: {
      openai: 'sk-proj-••••mnop',
      google: 'AIza••••OpQr',
      anthropic: null,
      openrouter: null,
    },
  });
});

test('PUT /api/admin/api-keys sets a single provider key', async () => {
  const calls = [];
  const deps = {
    setAdminApiKey: async (provider, key, adminId) => { calls.push({ provider, key, adminId }); return { provider, cleared: false }; },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'openai', apiKey: 'sk-new' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(calls, [{ provider: 'openai', key: 'sk-new', adminId: 'admin-1' }]);
});

test('PUT /api/admin/api-keys rejects unknown providers with 400', async () => {
  const deps = {
    setAdminApiKey: async () => { throw new Error('provider غير مدعوم'); },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'foobar', apiKey: 'x' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('PUT /api/admin/api-keys with empty key clears the slot', async () => {
  const calls = [];
  const deps = {
    setAdminApiKey: async (provider, key) => { calls.push({ provider, key }); return { provider, cleared: true }; },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'openai', apiKey: '' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.body.cleared, true);
  assert.deepEqual(calls, [{ provider: 'openai', key: '' }]);
});
