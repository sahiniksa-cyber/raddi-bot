'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { createSallaRoutes, toExpiryDate } = require('../src/routes/salla.routes');

function makeApp(env, extraDeps = {}) {
  const app = express();
  // Mirror production: JSON parsing for every route EXCEPT the webhook, which
  // needs the raw body for the HMAC signature (its own express.raw handles it).
  app.use((req, res, next) => {
    if (req.path === '/salla/webhook') return next();
    return express.json()(req, res, next);
  });
  const database = extraDeps.database || { query: async () => ({ rows: [], rowCount: 0 }) };
  app.use(createSallaRoutes({ env, ...extraDeps, database }));
  return app;
}

function sign(raw, secret) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function req(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
      const r = http.request({
        hostname: '127.0.0.1', port, method, path,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      r.on('error', (err) => { server.close(); reject(err); });
      if (data) r.write(data);
      r.end();
    });
  });
}

function fakeStores(storeRow = null) {
  return {
    authorized: [],
    uninstalled: [],
    async upsertStoreAuthorization(merchantId, payload) { this.authorized.push({ merchantId, payload }); },
    async markUninstalled(merchantId) { this.uninstalled.push(merchantId); },
    async getStore() { return storeRow; },
  };
}

test('503 when SALLA_WEBHOOK_SECRET is not configured', async () => {
  const s = fakeStores();
  const app = makeApp({}, { sallaStores: s });
  const res = await req(app, 'POST', '/salla/webhook', { body: { event: 'app.store.authorize' } });
  assert.equal(res.status, 503);
  assert.equal(s.authorized.length, 0);
});

test('rejects a bad signature (401) and stores nothing', async () => {
  const s = fakeStores();
  const app = makeApp({ SALLA_WEBHOOK_SECRET: 'S' }, { sallaStores: s });
  const res = await req(app, 'POST', '/salla/webhook', {
    headers: { 'X-Salla-Signature': 'deadbeef' },
    body: { event: 'app.store.authorize', merchant: 1, data: { access_token: 'x' } },
  });
  assert.equal(res.status, 401);
  assert.equal(s.authorized.length, 0);
});

test('stores the token on app.store.authorize (200)', async () => {
  const s = fakeStores();
  const secret = 'S';
  const payload = {
    event: 'app.store.authorize',
    merchant: 555,
    data: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires: 1893456000, scope: 'orders.read' },
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const app = makeApp({ SALLA_WEBHOOK_SECRET: secret }, { sallaStores: s });
  const res = await req(app, 'POST', '/salla/webhook', {
    headers: { 'X-Salla-Signature': sign(raw, secret) },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal(s.authorized.length, 1);
  assert.equal(s.authorized[0].merchantId, 555);
  assert.equal(s.authorized[0].payload.accessToken, 'ACCESS');
  assert.equal(s.authorized[0].payload.refreshToken, 'REFRESH');
  assert.equal(s.authorized[0].payload.scope, 'orders.read');
  assert.ok(s.authorized[0].payload.expiresAt instanceof Date);
});

test('marks the store uninstalled on app.uninstalled (200)', async () => {
  const s = fakeStores();
  const secret = 'S';
  const payload = { event: 'app.uninstalled', merchant: 777 };
  const raw = Buffer.from(JSON.stringify(payload));
  const app = makeApp({ SALLA_WEBHOOK_SECRET: secret }, { sallaStores: s });
  const res = await req(app, 'POST', '/salla/webhook', {
    headers: { 'X-Salla-Signature': sign(raw, secret) },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(s.uninstalled, [777]);
});

test('acknowledges non-token events with 200 without storing a token', async () => {
  const s = fakeStores(); // unlinked merchant (getStore → null) → no CRM ingest
  const secret = 'S';
  const payload = { event: 'product.updated', merchant: 1, data: { id: 99 } };
  const raw = Buffer.from(JSON.stringify(payload));
  const app = makeApp({ SALLA_WEBHOOK_SECRET: secret }, { sallaStores: s });
  const res = await req(app, 'POST', '/salla/webhook', {
    headers: { 'X-Salla-Signature': sign(raw, secret) },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal(s.authorized.length, 0);
});

test('order event for a linked merchant is routed to CRM ingest (200)', async () => {
  const s = fakeStores({ user_id: 'u-linked', merchant_id: '1' });
  const ingested = [];
  const sallaIngest = { ingestWebhookEvent: async (userId, body) => { ingested.push({ userId, event: body.event }); return { kind: 'order' }; } };
  const secret = 'S';
  const payload = { event: 'order.created', merchant: 1, data: { id: 99, status: { slug: 'completed' } } };
  const raw = Buffer.from(JSON.stringify(payload));
  const app = makeApp({ SALLA_WEBHOOK_SECRET: secret }, { sallaStores: s, sallaIngest });
  const res = await req(app, 'POST', '/salla/webhook', { headers: { 'X-Salla-Signature': sign(raw, secret) }, body: raw });
  assert.equal(res.status, 200);
  assert.deepEqual(ingested, [{ userId: 'u-linked', event: 'order.created' }]);
});

test('CRM ingest failure still returns 200 (never breaks the ack)', async () => {
  const s = fakeStores({ user_id: 'u-linked' });
  const sallaIngest = { ingestWebhookEvent: async () => { throw new Error('boom'); } };
  const secret = 'S';
  const payload = { event: 'order.created', merchant: 1, data: { id: 1 } };
  const raw = Buffer.from(JSON.stringify(payload));
  const app = makeApp({ SALLA_WEBHOOK_SECRET: secret }, { sallaStores: s, sallaIngest });
  const res = await req(app, 'POST', '/salla/webhook', { headers: { 'X-Salla-Signature': sign(raw, secret) }, body: raw });
  assert.equal(res.status, 200);
});

test('toExpiryDate converts Salla unix seconds to a Date', () => {
  const d = toExpiryDate(1893456000);
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1893456000 * 1000);
  assert.equal(toExpiryDate(null), null);
  assert.equal(toExpiryDate('nope'), null);
});
