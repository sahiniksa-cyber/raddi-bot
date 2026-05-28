'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const dbClientPath = require.resolve('../src/db/client');
const billingServicePath = require.resolve('../src/services/billing/billing-service');
const billingRoutesPath = require.resolve('../src/routes/billing.routes');
const moyasarClientPath = require.resolve('../src/services/billing/moyasar-client');

// Stub the billing-service to avoid touching the real db inside the route.
const calls = { handleMoyasarWebhookEvent: [] };
const billingStub = {
  activateWithCode: async () => ({ activated: false }),
  confirmProviderPayment: async () => ({}),
  getUserBillingState: async () => ({}),
  handleMoyasarWebhookEvent: async (event, signature) => {
    calls.handleMoyasarWebhookEvent.push({ event, signature });
    return { processed: true, activated: true };
  },
  isAdminUser: async () => false,
  updateAutoRenew: async () => ({}),
};

require.cache[billingServicePath] = {
  id: billingServicePath, filename: billingServicePath, loaded: true, exports: billingStub,
};

// Stub moyasar-client so requires don't try network calls if loaded.
require.cache[moyasarClientPath] = {
  id: moyasarClientPath, filename: moyasarClientPath, loaded: true,
  exports: {
    buildCallbackUrl: () => 'http://example.com/billing/callback',
    fetchMoyasarPayment: async () => ({}),
    isPaidPlatformAccessPayment: () => false,
    normalizeMoyasarPayment: (p) => ({ ...p, userId: '' }),
  },
};

// Stub the db client so /api/billing/messages doesn't crash on import.
require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true,
  exports: {
    query: async () => ({ rows: [] }),
    transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
};

delete require.cache[billingRoutesPath];
const { createBillingRoutes } = require('../src/routes/billing.routes');

const SECRET = 'test-webhook-secret';
process.env.MOYASAR_WEBHOOK_SECRET = SECRET;

function makeApp() {
  const app = express();
  // NOTE: deliberately do NOT mount express.json() globally — the webhook
  // route mounts its own express.raw inline, mirroring production behavior.
  app.use(createBillingRoutes({}));
  return app;
}

function postWebhook(app, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/billing/moyasar/webhook',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(data);
      req.end();
    });
  });
}

function sign(buf, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

test('rejects request with no signature header (401)', async () => {
  calls.handleMoyasarWebhookEvent = [];
  const app = makeApp();
  const res = await postWebhook(app, { id: 'pay_1', status: 'paid' });
  assert.equal(res.status, 401);
  assert.match(res.body, /no_signature/);
  assert.equal(calls.handleMoyasarWebhookEvent.length, 0);
});

test('rejects request with bad signature (401)', async () => {
  calls.handleMoyasarWebhookEvent = [];
  const app = makeApp();
  const res = await postWebhook(app, { id: 'pay_2', status: 'paid' }, {
    'x-moyasar-signature': 'deadbeef'.repeat(8), // hex but wrong
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /bad_signature/);
  assert.equal(calls.handleMoyasarWebhookEvent.length, 0);
});

test('accepts request with valid signature (200) and invokes service', async () => {
  calls.handleMoyasarWebhookEvent = [];
  const app = makeApp();
  const payload = Buffer.from(JSON.stringify({ id: 'pay_3', status: 'paid', metadata: { user_id: 'u1' } }));
  const sig = sign(payload);
  const res = await postWebhook(app, payload, { 'x-moyasar-signature': sig });
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);
  assert.equal(calls.handleMoyasarWebhookEvent.length, 1);
  assert.equal(calls.handleMoyasarWebhookEvent[0].event.id, 'pay_3');
  assert.equal(calls.handleMoyasarWebhookEvent[0].signature, sig);
});

test('returns 503 when MOYASAR_WEBHOOK_SECRET is not configured', async () => {
  const prev = process.env.MOYASAR_WEBHOOK_SECRET;
  delete process.env.MOYASAR_WEBHOOK_SECRET;
  const app = makeApp();
  const res = await postWebhook(app, { id: 'pay_x' });
  assert.equal(res.status, 503);
  assert.match(res.body, /webhook_disabled/);
  process.env.MOYASAR_WEBHOOK_SECRET = prev;
});

test('accepts the generic "signature" header as a fallback', async () => {
  calls.handleMoyasarWebhookEvent = [];
  const app = makeApp();
  const payload = Buffer.from(JSON.stringify({ id: 'pay_4', status: 'paid', metadata: { user_id: 'u4' } }));
  const sig = sign(payload);
  const res = await postWebhook(app, payload, { signature: sig });
  assert.equal(res.status, 200);
  assert.equal(calls.handleMoyasarWebhookEvent.length, 1);
});

test.after(() => {
  // Clean cache so other tests reload fresh modules.
  delete require.cache[billingRoutesPath];
  delete require.cache[billingServicePath];
  delete require.cache[moyasarClientPath];
  delete require.cache[dbClientPath];
});
