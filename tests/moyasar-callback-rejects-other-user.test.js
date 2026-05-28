'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const dbClientPath = require.resolve('../src/db/client');
const billingServicePath = require.resolve('../src/services/billing/billing-service');
const moyasarClientPath = require.resolve('../src/services/billing/moyasar-client');
const billingRoutesPath = require.resolve('../src/routes/billing.routes');

const confirmCalls = [];

// Stub billing-service: capture confirmProviderPayment calls.
require.cache[billingServicePath] = {
  id: billingServicePath, filename: billingServicePath, loaded: true,
  exports: {
    activateWithCode: async () => ({ activated: false }),
    confirmProviderPayment: async (...args) => { confirmCalls.push(args); return {}; },
    getUserBillingState: async () => ({}),
    handleMoyasarWebhookEvent: async () => ({}),
    isAdminUser: async () => false,
    updateAutoRenew: async () => ({}),
  },
};

// Stub the moyasar client: pretend Moyasar returned a paid payment belonging
// to user "victim".
require.cache[moyasarClientPath] = {
  id: moyasarClientPath, filename: moyasarClientPath, loaded: true,
  exports: {
    buildCallbackUrl: () => 'http://example.com/billing/callback',
    fetchMoyasarPayment: async () => ({
      id: 'pay_victim_1',
      status: 'paid',
      amount: 175000,
      currency: 'SAR',
      metadata: { user_id: 'victim' },
      source: { type: 'creditcard' },
    }),
    isPaidPlatformAccessPayment: () => true,
    normalizeMoyasarPayment: (p) => ({
      id: p.id,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      method: p.source?.type,
      providerPaymentId: p.id,
      userId: p.metadata?.user_id || '',
      raw: p,
    }),
  },
};

require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true,
  exports: { query: async () => ({ rows: [] }), transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
};

delete require.cache[billingRoutesPath];
const { createBillingRoutes } = require('../src/routes/billing.routes');

function makeApp(sessionUserId) {
  const app = express();
  // Fake auth that sets the session.
  app.use((req, res, next) => { req.session = { userId: sessionUserId }; next(); });
  app.use(createBillingRoutes({
    requireAuth: (req, res, next) => next(),
    billingSettings: { platformAccessPriceHalalas: 175000, currency: 'SAR' },
  }));
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') });
        });
      }).on('error', (err) => { server.close(); reject(err); });
    });
  });
}

test('GET /billing/callback rejects (403) when payment metadata user_id != session user_id', async () => {
  confirmCalls.length = 0;
  const app = makeApp('attacker');
  const res = await get(app, '/billing/callback?id=pay_victim_1');
  assert.equal(res.status, 403);
  assert.equal(confirmCalls.length, 0, 'confirmProviderPayment must NOT be called for mismatched user');
});

test('GET /billing/callback succeeds when payment metadata user_id == session user_id', async () => {
  confirmCalls.length = 0;
  const app = makeApp('victim');
  const res = await get(app, '/billing/callback?id=pay_victim_1');
  // Expect a 302 redirect to /?payment=paid (success path)
  assert.equal(res.status, 302);
  assert.match(String(res.location || ''), /payment=paid/);
  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0][0], 'victim');
});

test.after(() => {
  delete require.cache[billingRoutesPath];
  delete require.cache[billingServicePath];
  delete require.cache[moyasarClientPath];
  delete require.cache[dbClientPath];
});
