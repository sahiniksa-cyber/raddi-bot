'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createCustomerApiKeysHandlers, createAdminRoutes } = require('../src/routes/admin.routes');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

const UID = '22222222-2222-2222-2222-222222222222';

// ───────────────────────── Unit-level handler tests (dep-injected) ─────────

test('GET /api/admin/customers/:userId/api-keys returns masked keys map', async () => {
  const deps = {
    getCustomerApiKeysMaskedFor: async (uid) => {
      assert.equal(uid, UID);
      return {
        openai:     { masked: 'sk-proj-••••mnop', hasKey: true,  updated_at: '2026-05-28T00:00:00Z' },
        google:     { masked: null,               hasKey: false, updated_at: null },
        anthropic:  { masked: null,               hasKey: false, updated_at: null },
        openrouter: { masked: null,               hasKey: false, updated_at: null },
      };
    },
  };
  const { getKeys } = createCustomerApiKeysHandlers(deps);
  const res = fakeRes();
  await getKeys({ params: { userId: UID } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.keys.openai.masked, 'sk-proj-••••mnop');
  assert.equal(res.body.keys.openai.hasKey, true);
  assert.equal(res.body.keys.google.hasKey, false);
});

test('GET /api/admin/customers/:userId/api-keys rejects missing userId', async () => {
  const { getKeys } = createCustomerApiKeysHandlers({
    getCustomerApiKeysMaskedFor: async () => ({}),
  });
  const res = fakeRes();
  await getKeys({ params: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('PUT /api/admin/customers/:userId/api-keys saves a new key and returns masked', async () => {
  const calls = [];
  const deps = {
    setCustomerApiKey: async ({ userId, provider, apiKey, adminUserId }) => {
      calls.push({ userId, provider, apiKey, adminUserId });
      return { userId, provider, cleared: false, format: 'aes-256-gcm' };
    },
    getCustomerApiKeysMaskedFor: async (uid) => ({
      openai:     { masked: 'sk-proj-••••wxyz', hasKey: true,  updated_at: '2026-05-28T00:00:00Z' },
      google:     { masked: null, hasKey: false, updated_at: null },
      anthropic:  { masked: null, hasKey: false, updated_at: null },
      openrouter: { masked: null, hasKey: false, updated_at: null },
    }),
  };
  const { putKey } = createCustomerApiKeysHandlers(deps);
  const req = {
    params: { userId: UID },
    body: { provider: 'openai', apiKey: 'sk-proj-newkeyhereabcdwxyz' },
    session: { userId: 'admin-7' },
  };
  const res = fakeRes();
  await putKey(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.provider, 'openai');
  assert.equal(res.body.cleared, false);
  assert.equal(res.body.masked, 'sk-proj-••••wxyz');
  assert.equal(res.body.hasKey, true);

  assert.deepEqual(calls, [{
    userId: UID,
    provider: 'openai',
    apiKey: 'sk-proj-newkeyhereabcdwxyz',
    adminUserId: 'admin-7',
  }]);
});

test('PUT /api/admin/customers/:userId/api-keys with empty apiKey clears the slot', async () => {
  const calls = [];
  const deps = {
    setCustomerApiKey: async ({ userId, provider, apiKey, adminUserId }) => {
      calls.push({ userId, provider, apiKey, adminUserId });
      return { userId, provider, cleared: true };
    },
    getCustomerApiKeysMaskedFor: async () => ({
      openai:     { masked: null, hasKey: false, updated_at: null },
      google:     { masked: null, hasKey: false, updated_at: null },
      anthropic:  { masked: null, hasKey: false, updated_at: null },
      openrouter: { masked: null, hasKey: false, updated_at: null },
    }),
  };
  const { putKey } = createCustomerApiKeysHandlers(deps);
  const req = {
    params: { userId: UID },
    body: { provider: 'openai', apiKey: '' },
    session: { userId: 'admin-7' },
  };
  const res = fakeRes();
  await putKey(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cleared, true);
  assert.equal(res.body.hasKey, false);
  assert.equal(res.body.masked, null);
  assert.deepEqual(calls, [{ userId: UID, provider: 'openai', apiKey: '', adminUserId: 'admin-7' }]);
});

test('PUT /api/admin/customers/:userId/api-keys rejects unknown providers with 400', async () => {
  const deps = {
    setCustomerApiKey: async () => { throw new Error('provider غير مدعوم: foobar'); },
    getCustomerApiKeysMaskedFor: async () => ({}),
  };
  const { putKey } = createCustomerApiKeysHandlers(deps);
  const req = {
    params: { userId: UID },
    body: { provider: 'foobar', apiKey: 'x' },
    session: { userId: 'admin-7' },
  };
  const res = fakeRes();
  await putKey(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

// ───────────────────────── Integration-level tests (route + middleware) ─────

function startApp(routerOpts) {
  const app = express();
  app.use(express.json());
  // simple session shim
  app.use((req, _res, next) => { req.session = req.session || {}; next(); });
  if (routerOpts.requireAuth) app.use(routerOpts.requireAuth);
  app.use(createAdminRoutes({ ...routerOpts, dashboardDir: '/tmp' }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
        : {},
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch (_) { parsed = { raw: chunks }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('GET /api/admin/customers/:userId/api-keys returns 401 without admin session', async () => {
  const { server, port } = await startApp({
    // No requireAuth → no session.isAdmin → requireOwner should 401 on /api/
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await request(port, 'GET', `/api/admin/customers/${UID}/api-keys`);
    assert.equal(r.status, 401);
    assert.equal(r.body.success, false);
  } finally {
    server.close();
  }
});

test('PUT /api/admin/customers/:userId/api-keys returns 401 without admin session', async () => {
  const { server, port } = await startApp({
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await request(port, 'PUT', `/api/admin/customers/${UID}/api-keys`, {
      provider: 'openai',
      apiKey: 'sk-attempt',
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.success, false);
  } finally {
    server.close();
  }
});
