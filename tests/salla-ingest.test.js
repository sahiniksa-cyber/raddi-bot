'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingest = require('../src/services/salla/salla-ingest');

function fakeDeps() {
  const queries = [];
  const recomputed = [];
  return {
    queries, recomputed,
    database: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } },
    resolver: { resolveCustomer: async (userId, signal) => ({ customerId: 'cust-' + (signal.sallaCustomerId || signal.phone || 'x'), created: false, matchedBy: 'phone' }) },
    metrics: {
      isQualifiedPurchase: (slug) => ['completed', 'delivered', 'shipped', 'delivering', 'in_progress'].includes(slug),
      recomputeCustomer: async (userId, customerId) => { recomputed.push(customerId); },
    },
  };
}

test('ingestOrder resolves customer, upserts crm_orders, marks qualified, recomputes', async () => {
  const deps = fakeDeps();
  const r = await ingest.ingestOrder('u1', {
    id: 28192, status: { slug: 'completed' }, total: { amount: 150, currency: 'SAR' },
    customer: { id: 18292, mobile_code: '966', mobile: '501234567' }, date: { date: '2026-08-10 15:18:00' },
  }, deps);
  assert.equal(r.customerId, 'cust-18292');
  assert.equal(r.qualified, true);
  assert.ok(deps.queries.some((q) => /INSERT INTO crm_orders/.test(q.sql)), 'upserts crm_orders');
  assert.ok(deps.queries.some((q) => /INSERT INTO crm_timeline_events/.test(q.sql)), 'adds timeline event');
  assert.deepEqual(deps.recomputed, ['cust-18292'], 'recomputes metrics once');
});

test('ingestOrder with a cancelled status is stored but NOT qualified', async () => {
  const deps = fakeDeps();
  const r = await ingest.ingestOrder('u1', { id: 5, status: { slug: 'canceled' }, total: { amount: 10 }, customer: { id: 1 } }, deps);
  assert.equal(r.qualified, false);
  const orderInsert = deps.queries.find((q) => /INSERT INTO crm_orders/.test(q.sql));
  assert.equal(orderInsert.params[6], false, 'is_qualified_purchase param is false');
});

test('ingestCart records an abandoned cart and recomputes', async () => {
  const deps = fakeDeps();
  const r = await ingest.ingestCart('u1', { id: 'cart9', total: { amount: 80, currency: 'SAR' }, customer: { id: 18292 } }, 'abandoned', deps);
  assert.equal(r.status, 'abandoned');
  assert.ok(deps.queries.some((q) => /INSERT INTO crm_carts/.test(q.sql)));
  assert.deepEqual(deps.recomputed, ['cust-18292']);
});

test('ingestWebhookEvent routes order.* / customer.* / abandoned.cart.* events', async () => {
  const order = await ingest.ingestWebhookEvent('u1', { event: 'order.created', data: { id: 1, status: { slug: 'completed' }, total: { amount: 1 }, customer: { id: 7 } } }, fakeDeps());
  assert.equal(order.kind, 'order');
  const cust = await ingest.ingestWebhookEvent('u1', { event: 'customer.created', data: { id: 7, mobile_code: '966', mobile: '500000000' } }, fakeDeps());
  assert.equal(cust.kind, 'customer');
  const cart = await ingest.ingestWebhookEvent('u1', { event: 'abandoned.cart.purchased', data: { id: 'c1', customer: { id: 7 } } }, fakeDeps());
  assert.equal(cart.kind, 'cart');
  const none = await ingest.ingestWebhookEvent('u1', { event: 'app.updated', data: {} }, fakeDeps());
  assert.equal(none, null);
});
