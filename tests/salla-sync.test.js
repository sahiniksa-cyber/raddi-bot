'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runInitialSync } = require('../src/services/salla/salla-sync');
const { backfillConversations } = require('../src/services/identity/backfill');

test('runInitialSync walks customers→orders→carts and completes the job', async () => {
  const jobUpdates = [];
  const database = {
    async query(sql, params) {
      if (/INSERT INTO salla_sync_jobs/.test(sql)) return { rows: [{ id: 'job1' }] };
      if (/UPDATE salla_sync_jobs/.test(sql)) jobUpdates.push({ sql, params });
      return { rows: [] };
    },
  };
  const calls = { customers: 0, orders: 0, carts: 0 };
  const api = {
    async* iterateCustomers() { yield { id: 1 }; yield { id: 2 }; },
    async* iterateOrders() { yield { id: 10, customer: { id: 1 }, status: { slug: 'completed' }, total: { amount: 5 } }; },
    async* iterateAbandonedCarts() { yield { id: 'c1', customer: { id: 2 } }; },
  };
  const ingest = {
    async ingestCustomer() { calls.customers += 1; },
    async ingestOrder() { calls.orders += 1; return {}; },
    async ingestCart() { calls.carts += 1; return {}; },
  };
  const res = await runInitialSync('u1', 'm1', { database, api, ingest, token: 'T' });
  assert.deepEqual(calls, { customers: 2, orders: 1, carts: 1 });
  assert.equal(res.customers, 2);
  // Job finished as completed.
  assert.ok(jobUpdates.some((u) => /status=\$2/.test(u.sql) && u.params[1] === 'completed'));
});

test('runInitialSync marks the job failed on error and rethrows', async () => {
  let finishedFailed = false;
  const database = {
    async query(sql, params) {
      if (/INSERT INTO salla_sync_jobs/.test(sql)) return { rows: [{ id: 'j' }] };
      if (/UPDATE salla_sync_jobs SET status=\$2/.test(sql) && params[1] === 'failed') finishedFailed = true;
      return { rows: [] };
    },
  };
  const api = {
    async* iterateCustomers() { throw new Error('api down'); },
    async* iterateOrders() {}, async* iterateAbandonedCarts() {},
  };
  await assert.rejects(() => runInitialSync('u1', 'm1', { database, api, ingest: {}, token: 'T' }));
  assert.equal(finishedFailed, true);
});

test('backfillConversations links unlinked conversations and dedupes by resolved customer', async () => {
  let batch = [
    { id: 'conv1', sender: '966501234567@s.whatsapp.net', phone_number: '966501234567' },
    { id: 'conv2', sender: '111@lid', phone_number: null },
  ];
  const updated = [];
  const database = {
    async query(sql, params) {
      if (/SELECT id, sender, phone_number FROM conversations/.test(sql)) {
        const rows = batch; batch = []; return { rows };
      }
      if (/UPDATE conversations SET customer_id/.test(sql)) { updated.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const resolver = { resolveCustomer: async (u, sig) => ({ customerId: sig.whatsappLid ? 'cLid' : 'cPhone' }) };
  const res = await backfillConversations('u1', { database, resolver });
  assert.equal(res.processed, 2);
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[0], ['conv1', 'cPhone']);
  assert.deepEqual(updated[1], ['conv2', 'cLid']);
});
