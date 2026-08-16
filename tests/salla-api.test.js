'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/services/salla/salla-api');

// Fake fetch that serves canned JSON per URL (optionally page-aware).
function fakeFetch(handler) {
  return async (url, opts) => {
    const { status, body } = handler(url, opts);
    return { status: status || 200, json: async () => body };
  };
}

test('iterateCustomers paginates across all pages', async () => {
  const pages = {
    1: { data: [{ id: 1 }, { id: 2 }], pagination: { currentPage: 1, totalPages: 2 } },
    2: { data: [{ id: 3 }], pagination: { currentPage: 2, totalPages: 2 } },
  };
  const fetch = fakeFetch((url) => {
    const page = new URL(url).searchParams.get('page') || '1';
    return { body: pages[page] };
  });
  const out = [];
  for await (const c of api.iterateCustomers({ token: 'T' }, { fetch })) out.push(c.id);
  assert.deepEqual(out, [1, 2, 3]);
});

test('iterate stops when a page returns no items (guard against infinite loop)', async () => {
  const fetch = fakeFetch(() => ({ body: { data: [], pagination: { currentPage: 1, totalPages: 99 } } }));
  const out = [];
  for await (const c of api.iterateCustomers({ token: 'T' }, { fetch })) out.push(c);
  assert.equal(out.length, 0);
});

test('sends the Bearer token and hits the admin/v2 base', async () => {
  let seenUrl = ''; let seenAuth = '';
  const fetch = fakeFetch((url, opts) => {
    seenUrl = url; seenAuth = opts.headers.Authorization;
    return { body: { data: [], pagination: { currentPage: 1, totalPages: 1 } } };
  });
  await api.listCustomersPage({ token: 'TOK', page: 1 }, { fetch });
  assert.match(seenUrl, /^https:\/\/api\.salla\.dev\/admin\/v2\/customers\?/);
  assert.equal(seenAuth, 'Bearer TOK');
});

test('orders can be filtered by customer_id', async () => {
  let seenUrl = '';
  const fetch = fakeFetch((url) => { seenUrl = url; return { body: { data: [], pagination: {} } }; });
  await api.listOrdersPage({ token: 'T', customerId: 555, page: 1 }, { fetch });
  assert.match(seenUrl, /\/orders\?/);
  assert.equal(new URL(seenUrl).searchParams.get('customer_id'), '555');
});

test('401 throws a typed SALLA_UNAUTHORIZED error (so callers can refresh)', async () => {
  const fetch = fakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
  await assert.rejects(
    () => api.listCustomersPage({ token: 'bad' }, { fetch }),
    (e) => e.code === 'SALLA_UNAUTHORIZED' && e.status === 401,
  );
});

test('mapSallaCustomerToSignal builds a phone from mobile_code + mobile', () => {
  const sig = api.mapSallaCustomerToSignal({ id: 18292, mobile_code: '966', mobile: '501234567', email: 'A@X.com', full_name: 'محمد أحمد' });
  assert.equal(sig.sallaCustomerId, '18292');
  assert.equal(sig.phone, '966501234567');
  assert.equal(sig.email, 'A@X.com');
  assert.equal(sig.name, 'محمد أحمد');
});

test('mapSallaOrder extracts status slug, total, customer id, coupon', () => {
  const o = api.mapSallaOrder({
    id: 28192, reference_id: 'R1',
    status: { id: 5, name: 'تم التنفيذ', slug: 'completed' },
    total: { amount: 150, currency: 'SAR' },
    customer: { id: 18292 },
    coupon: { code: 'PRO10' },
    date: { date: '2026-08-10 15:18:00' },
    items: [{ name: 'اشتراك', quantity: 1 }],
  });
  assert.equal(o.sallaOrderId, '28192');
  assert.equal(o.statusSlug, 'completed');
  assert.equal(o.totalAmount, 150);
  assert.equal(o.currency, 'SAR');
  assert.equal(o.sallaCustomerId, '18292');
  assert.equal(o.couponCode, 'PRO10');
  assert.ok(o.placedAt);
});
