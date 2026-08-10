'use strict';

// End-to-end acceptance for the Customer Intelligence layer (design spec §34-36).
// Drives the REAL identity resolver + metrics engine through full customer
// journeys, asserting the two guarantees the owner cares about most:
//   (1) no duplicate customers, ever;
//   (2) correct, live reclassification as events arrive.
// Runs at the algorithm level (in-memory identity store + world state) so it is
// deterministic and needs no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCustomer } = require('../src/services/identity/identity-resolver');
const { computeMetrics } = require('../src/services/identity/customer-metrics');
const { canonicalDigits } = require('../src/services/identity/phone');

const T = (s) => new Date(s);

function memIdentityStore() {
  let seq = 0;
  const customers = new Map();
  const identities = [];
  const FIELDS = ['canonical_phone', 'email', 'salla_customer_id', 'display_name', 'first_seen_at'];
  return {
    customers, identities,
    async findCustomerIdByIdentity(u, t, v) { const r = identities.find((i) => i.user_id === u && i.identity_type === t && i.identity_value === v); return r ? r.customer_id : null; },
    async createCustomer(u, f) { const id = 'c' + (++seq); const row = { id, user_id: u }; for (const k of FIELDS) row[k] = f[k] != null ? f[k] : null; customers.set(id, row); return id; },
    async addIdentity(u, cid, t, v, reason, conf) { const ex = identities.find((i) => i.user_id === u && i.identity_type === t && i.identity_value === v); if (ex) return ex.customer_id; identities.push({ user_id: u, customer_id: cid, identity_type: t, identity_value: v, match_reason: reason, confidence: conf }); return cid; },
    async getCustomer(u, id) { const c = customers.get(id); return c && c.user_id === u ? c : null; },
    async updateCustomerFields(u, id, f) { const c = customers.get(id); if (!c) return; for (const k of FIELDS) if (f[k] != null && c[k] == null) c[k] = f[k]; },
    async mergeCustomers(u, keep, merge) { for (const i of identities) if (i.customer_id === merge) i.customer_id = keep; const k = customers.get(keep); const m = customers.get(merge); for (const f of FIELDS) if (k[f] == null && m[f] != null) k[f] = m[f]; customers.delete(merge); },
  };
}

// A tiny "world" that mirrors what the DB would hold, so we can compute metrics.
function makeWorld() {
  const store = memIdentityStore();
  const orders = new Map();
  const carts = new Map();
  const conv = new Map();
  const push = (map, cid, v) => { if (!map.has(cid)) map.set(cid, []); map.get(cid).push(v); };
  const remap = (map, keep, merge) => { if (map.has(merge)) { for (const v of map.get(merge)) push(map, keep, v); map.delete(merge); } };

  const origMerge = store.mergeCustomers.bind(store);
  store.mergeCustomers = async (u, keep, merge, r, mo) => {
    await origMerge(u, keep, merge, r, mo);
    remap(orders, keep, merge); remap(carts, keep, merge);
    if (conv.has(merge)) {
      const a = conv.get(keep) || {}; const b = conv.get(merge);
      conv.set(keep, mergeConv(a, b)); conv.delete(merge);
    }
  };

  const deps = { store };
  return {
    store, orders, carts, conv,
    countCustomers: (u) => [...store.customers.values()].filter((c) => c.user_id === u).length,
    currentIdByPhone: (u, phone) => store.findCustomerIdByIdentity(u, 'phone', canonicalDigits(phone)),
    async wa(u, signal, at) {
      const { customerId } = await resolveCustomer(u, signal, deps);
      const prev = conv.get(customerId) || {};
      conv.set(customerId, mergeConv(prev, { hasConversation: true, firstContactAt: at, firstConversationAt: at, lastMessageAt: at, conversationCount: 1 }));
      return customerId;
    },
    async sallaCustomer(u, signal) { return (await resolveCustomer(u, { ...signal, source: 'salla_customer' }, deps)).customerId; },
    async order(u, signal, orderData) { const { customerId } = await resolveCustomer(u, { ...signal, source: 'salla_order' }, deps); push(orders, customerId, orderData); return customerId; },
    async cart(u, signal, cartData) { const { customerId } = await resolveCustomer(u, { ...signal, source: 'salla_cart' }, deps); push(carts, customerId, cartData); return customerId; },
    metrics(cid) { return computeMetrics({ orders: orders.get(cid) || [], carts: carts.get(cid) || [], conversation: conv.get(cid) || {} }); },
  };
}

function mergeConv(a, b) {
  const min = (x, y) => (!x ? y : !y ? x : (x < y ? x : y));
  const max = (x, y) => (!x ? y : !y ? x : (x > y ? x : y));
  return {
    hasConversation: Boolean(a.hasConversation || b.hasConversation),
    firstContactAt: min(a.firstContactAt, b.firstContactAt),
    firstConversationAt: min(a.firstConversationAt, b.firstConversationAt),
    lastMessageAt: max(a.lastMessageAt, b.lastMessageAt),
    conversationCount: (a.conversationCount || 0) + (b.conversationCount || 0),
  };
}

test('Scenario 1: WA lead → appears in Salla → abandons cart → orders (no dup, live reclassify)', async () => {
  const w = makeWorld(); const u = 'u1';
  // 1) New WhatsApp lead.
  const cid = await w.wa(u, { whatsappSender: '966501234567@s.whatsapp.net', phone: '0501234567' }, T('2026-08-10T10:00:00Z'));
  assert.equal(w.countCustomers(u), 1);
  assert.equal(w.metrics(cid).segments.asked_not_ordered, true);

  // 2) Same person shows up as a Salla customer (same phone) — MUST NOT duplicate.
  await w.sallaCustomer(u, { sallaCustomerId: '900', phone: '0501234567' });
  assert.equal(w.countCustomers(u), 1);

  // 3) Abandons a cart.
  await w.cart(u, { sallaCustomerId: '900', phone: '0501234567' }, { status: 'abandoned', totalAmount: 80, abandonedAt: T('2026-08-10T14:00:00Z') });
  let m = w.metrics(cid);
  assert.equal(m.segments.asked_not_ordered, true);
  assert.equal(m.has_abandoned_cart, true);
  assert.equal(m.segments.cart_abandoned_no_purchase, true);

  // 4) Places a qualifying order (contact was BEFORE the order).
  await w.order(u, { sallaCustomerId: '900', phone: '0501234567' }, { statusSlug: 'completed', totalAmount: 150, placedAt: T('2026-08-10T15:18:00Z'), items: [{ name: 'اشتراك أدوبي' }] });
  m = w.metrics(cid);
  assert.equal(w.countCustomers(u), 1, 'still exactly one customer');
  assert.equal(m.orders_count, 1);
  assert.equal(m.segments.asked_not_ordered, false, 'removed from لم يطلب');
  assert.equal(m.segments.cart_abandoned_no_purchase, false, 'cart-reminder segment no longer applies');
  assert.equal(m.segments.asked_then_ordered, true, 'now in سأل ثم طلب');
  assert.equal(m.contacted_before_purchase, true);
  assert.ok(m.time_to_conversion_seconds > 0);
  assert.equal(m.first_product, 'اشتراك أدوبي');
});

test('Scenario 2: direct Salla buyer → later WhatsApp = طلب ثم تواصل (not سأل ثم طلب, no new lead)', async () => {
  const w = makeWorld(); const u = 'u2';
  const cid = await w.order(u, { sallaCustomerId: 'S2', phone: '0559999999' }, { statusSlug: 'completed', totalAmount: 100, placedAt: T('2026-08-10T15:00:00Z') });
  let m = w.metrics(cid);
  assert.equal(m.segments.ordered_no_contact, true);
  assert.equal(w.countCustomers(u), 1);

  // Next day the same phone messages on WhatsApp.
  await w.wa(u, { whatsappSender: 'z@s.whatsapp.net', phone: '0559999999' }, T('2026-08-11T10:00:00Z'));
  assert.equal(w.countCustomers(u), 1, 'no new lead created');
  m = w.metrics(cid);
  assert.equal(m.segments.ordered_then_contacted, true);
  assert.equal(m.segments.asked_then_ordered, false);
  assert.equal(m.segments.ordered_no_contact, false);
});

test('Scenario 3: very old chat, much later purchase → raw chronology preserved for attribution', async () => {
  const w = makeWorld(); const u = 'u3';
  await w.wa(u, { phone: '0501112222' }, T('2025-08-01T00:00:00Z'));
  const cid = await w.order(u, { sallaCustomerId: 'S3', phone: '0501112222' }, { statusSlug: 'completed', totalAmount: 50, placedAt: T('2026-08-01T00:00:00Z') });
  const m = w.metrics(cid);
  assert.equal(w.countCustomers(u), 1);
  assert.equal(m.contacted_before_purchase, true);
  // ~1 year gap preserved as raw seconds; a short attribution window would not credit it.
  assert.ok(m.time_to_conversion_seconds > 300 * 86400);
});

test('Scenario 4: many sources for one phone collapse to a single customer', async () => {
  const w = makeWorld(); const u = 'u4';
  await w.wa(u, { whatsappSender: 'A@s.whatsapp.net', phone: '0501234567' }, T('2026-08-10T09:00:00Z'));
  await w.sallaCustomer(u, { sallaCustomerId: 'C', phone: '0501234567' });
  await w.order(u, { sallaCustomerId: 'C', phone: '0501234567' }, { statusSlug: 'completed', totalAmount: 10, placedAt: T('2026-08-10T10:00:00Z') });
  await w.cart(u, { sallaCustomerId: 'C', phone: '0501234567' }, { status: 'abandoned', totalAmount: 10, abandonedAt: T('2026-08-10T08:00:00Z') });
  assert.equal(w.countCustomers(u), 1, 'WA + Salla customer + order + cart → ONE customer');
});

test('Scenario 4b: two records proven to be one person auto-merge (phone + salla id)', async () => {
  const w = makeWorld(); const u = 'u5';
  // A phone-only WhatsApp customer and a salla-id-only Salla customer exist separately.
  const cPhone = await w.wa(u, { phone: '0501234567' }, T('2026-08-10T09:00:00Z'));
  const cSalla = await w.sallaCustomer(u, { sallaCustomerId: 'Z1' });
  assert.notEqual(cPhone, cSalla);
  assert.equal(w.countCustomers(u), 2);
  // An order carrying BOTH keys proves they are the same person → merge to one.
  await w.order(u, { sallaCustomerId: 'Z1', phone: '0501234567' }, { statusSlug: 'completed', totalAmount: 20, placedAt: T('2026-08-10T11:00:00Z') });
  assert.equal(w.countCustomers(u), 1, 'the two records merged into one');
  const survivor = await w.currentIdByPhone(u, '0501234567');
  const m = w.metrics(survivor);
  assert.equal(m.orders_count, 1);
});
