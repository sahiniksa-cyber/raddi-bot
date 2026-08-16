'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const read = require('../src/services/identity/crm-read');

function capture(rows = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } };
}

test('listCustomers scopes by user, splices rule params after $1, paginates', async () => {
  const db = capture([{ id: 'c1' }]);
  const r = await read.listCustomers('u1', {
    rules: { op: 'and', conditions: [{ field: 'orders_count', operator: 'gte', value: 2 }] },
    page: 2, pageSize: 10,
  }, { database: db });
  const q = db.calls[0];
  assert.match(q.sql, /c\.user_id = \$1/);
  assert.match(q.sql, /m\.orders_count >= \$2/);
  assert.match(q.sql, /LIMIT 10 OFFSET 10/);
  assert.deepEqual(q.params, ['u1', 2]);
  assert.deepEqual(r.customers, [{ id: 'c1' }]);
});

test('listCustomers with the "all" segment adds no extra WHERE and no rule params', async () => {
  const db = capture();
  await read.listCustomers('u1', { rules: { segment: 'all' } }, { database: db });
  assert.deepEqual(db.calls[0].params, ['u1']);
  assert.doesNotMatch(db.calls[0].sql, /\$2/);
});

test('countSegment returns the integer count for a compiled segment', async () => {
  const db = capture([{ n: 2842 }]);
  const n = await read.countSegment('u1', { segment: 'asked_not_ordered' }, { database: db });
  assert.equal(n, 2842);
  assert.match(db.calls[0].sql, /COUNT\(\*\)/);
});

test('searchCustomers matches name/email/phone/salla id/order ref', async () => {
  const db = capture([{ id: 'c1' }]);
  await read.searchCustomers('u1', '0501234567', { database: db });
  const q = db.calls[0];
  assert.deepEqual(q.params, ['u1', '%0501234567%', '966501234567', '0501234567']);
  assert.match(q.sql, /canonical_phone = \$3/);
});

test('getCustomer360 returns null for an unknown customer', async () => {
  const db = capture([]);
  const r = await read.getCustomer360('u1', 'nope', { database: db });
  assert.equal(r, null);
});

test('getCustomer360 assembles profile + metrics + orders + carts + timeline + identities', async () => {
  let call = 0;
  const db = {
    query: async () => {
      call += 1;
      if (call === 1) return { rows: [{ id: 'c1', display_name: 'محمد' }] }; // customer
      if (call === 2) return { rows: [{ orders_count: 1 }] }; // metrics
      if (call === 3) return { rows: [{ salla_order_id: '9' }] }; // orders
      if (call === 4) return { rows: [] }; // carts
      if (call === 5) return { rows: [{ event_type: 'order_created' }] }; // timeline
      return { rows: [{ identity_type: 'phone', identity_value: '966...' }] }; // identities
    },
  };
  const r = await read.getCustomer360('u1', 'c1', { database: db });
  assert.equal(r.customer.display_name, 'محمد');
  assert.equal(r.metrics.orders_count, 1);
  assert.equal(r.orders[0].salla_order_id, '9');
  assert.equal(r.timeline[0].event_type, 'order_created');
  assert.equal(r.identities[0].identity_type, 'phone');
});
