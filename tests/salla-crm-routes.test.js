'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createSallaCrmRoutes } = require('../src/routes/salla-crm.routes');

function makeApp(env, extraDeps = {}) {
  const app = express();
  app.use((req, _res, next) => { req.session = extraDeps.session || { userId: 'u1' }; next(); });
  app.use(express.json());
  const database = extraDeps.database || { query: async () => ({ rows: [] }) };
  app.use(createSallaCrmRoutes({ env, ...extraDeps, database }));
  return app;
}

function req(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const r = http.request({ hostname: '127.0.0.1', port, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (data) r.write(data);
      r.end();
    });
  });
}

const ON = { SALLA_CRM_ENABLED: 'true' };

test('every route is 503 when SALLA_CRM_ENABLED is off (ships dark)', async () => {
  const app = makeApp({});
  const res = await req(app, 'GET', '/api/salla/quick-segments');
  assert.equal(res.status, 503);
});

test('quick-segments lists the ready-made lists', async () => {
  const app = makeApp(ON);
  const res = await req(app, 'GET', '/api/salla/quick-segments');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.segments.some((s) => s.key === 'asked_not_ordered'));
});

test('customers list resolves a quick segment and scopes by session user', async () => {
  const seen = [];
  const crmRead = { listCustomers: async (userId, opts) => { seen.push({ userId, opts }); return { customers: [{ id: 'c1' }], page: 1 }; } };
  const app = makeApp(ON, { crmRead });
  const res = await req(app, 'GET', '/api/salla/customers?segment=asked_not_ordered');
  assert.equal(res.status, 200);
  assert.equal(seen[0].userId, 'u1');
  assert.deepEqual(seen[0].opts.rules, { segment: 'asked_not_ordered' });
});

test('audience count validates rules and returns the number', async () => {
  const crmRead = { countSegment: async () => 2842 };
  const app = makeApp(ON, { crmRead });
  const res = await req(app, 'POST', '/api/salla/audience/count', { rules: { field: 'orders_count', operator: 'gte', value: 2 } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).count, 2842);
});

test('audience count rejects malformed rules with 400 (no crash / no injection)', async () => {
  const app = makeApp(ON, { crmRead: { countSegment: async () => 0 } });
  const res = await req(app, 'POST', '/api/salla/audience/count', { rules: { field: 'DROP TABLE', operator: 'eq', value: 1 } });
  assert.equal(res.status, 400);
});

test('customer 360 returns 404 when missing', async () => {
  const app = makeApp(ON, { crmRead: { getCustomer360: async () => null } });
  const res = await req(app, 'GET', '/api/salla/customers/nope');
  assert.equal(res.status, 404);
});

test('sync trigger 400s without a linked store, 202 with one', async () => {
  const noStore = makeApp(ON, { database: { query: async () => ({ rows: [] }) } });
  assert.equal((await req(noStore, 'POST', '/api/salla/sync')).status, 400);

  let ran = null;
  const withStore = makeApp(ON, {
    database: { query: async () => ({ rows: [{ merchant_id: 'm1' }] }) },
    sallaSync: { runInitialSync: async (u, m) => { ran = { u, m }; } },
  });
  const res = await req(withStore, 'POST', '/api/salla/sync');
  assert.equal(res.status, 202);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, { u: 'u1', m: 'm1' });
});

test('link claims an unlinked store, 409 if owned by someone else', async () => {
  const stores1 = { getStore: async () => ({ merchant_id: 'm1', user_id: null }), linkUser: async () => {} };
  const app1 = makeApp(ON, { sallaStores: stores1 });
  assert.equal((await req(app1, 'POST', '/api/salla/link', { merchantId: 'm1' })).status, 200);

  const stores2 = { getStore: async () => ({ merchant_id: 'm1', user_id: 'someone-else' }), linkUser: async () => {} };
  const app2 = makeApp(ON, { sallaStores: stores2 });
  assert.equal((await req(app2, 'POST', '/api/salla/link', { merchantId: 'm1' })).status, 409);
});
