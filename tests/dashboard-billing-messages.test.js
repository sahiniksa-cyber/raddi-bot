'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');

// Stub the message-quota module BEFORE requiring billing routes,
// so the route picks up our stub instead of the real DB-backed one.
const stubPath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js');
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, exports: {
    computeEffectiveRemaining: () => 2847,
    checkMessageQuota: async () => ({ canReply: true, remaining: 2847 }),
  }
};

// Stub db so the route's db.query returns a deterministic row.
const dbPath = path.resolve(__dirname, '..', 'src', 'db', 'client.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    isConfigured: () => true,
    query: async () => ({
      rows: [{
        messages_remaining: 2847,
        quota_expires_at: new Date(Date.now() + 86400000 * 22).toISOString(),
        expire_resets_quota: true,
        last_topup_amount: 3000,
        last_topup_at: new Date().toISOString(),
        // Deliberately different from (last_topup - remaining) = 153 so the test
        // proves the route reads the tracked column, not the old derivation.
        messages_used: 410,
      }],
    }),
  }
};

const { createBillingRoutes } = require('../src/routes/billing.routes');

function startApp(routerOpts) {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });
  app.use(createBillingRoutes(routerOpts));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: p }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    }).on('error', reject);
  });
}

test('GET /api/billing/messages returns quota snapshot', async () => {
  const { server, port } = await startApp({
    requireAuth: (_req, _res, next) => next(),
    billingSettings: { supportWhatsappPhone: '966500000000' },
  });
  try {
    const r = await getJson(port, '/api/billing/messages');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.remaining, 'number');
    assert.equal(r.body.supportWhatsappPhone, '966500000000');
    assert.ok(['active', 'empty', 'expired'].includes(r.body.status));
    assert.equal(r.body.used, 410, 'used must come from the tracked messages_used column');
  } finally {
    server.close();
  }
});
