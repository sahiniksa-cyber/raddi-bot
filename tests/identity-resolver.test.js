'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCustomer } = require('../src/services/identity/identity-resolver');

// In-memory fake of the customer-store interface. Exercises the resolution
// ALGORITHM (where the duplicate-prevention risk lives) without a database.
function memStore() {
  let seq = 0;
  const customers = new Map();
  const identities = [];
  const merges = [];
  const FIELDS = ['canonical_phone', 'email', 'salla_customer_id', 'display_name', 'first_seen_at'];
  return {
    customers, identities, merges,
    async findCustomerIdByIdentity(userId, type, value) {
      const row = identities.find((i) => i.user_id === userId && i.identity_type === type && i.identity_value === value);
      return row ? row.customer_id : null;
    },
    async createCustomer(userId, f) {
      const id = 'c' + (++seq);
      const row = { id, user_id: userId };
      for (const k of FIELDS) row[k] = f[k] != null ? f[k] : null;
      customers.set(id, row);
      return id;
    },
    async addIdentity(userId, customerId, type, value, reason, confidence) {
      const ex = identities.find((i) => i.user_id === userId && i.identity_type === type && i.identity_value === value);
      if (ex) return ex.customer_id;
      identities.push({ user_id: userId, customer_id: customerId, identity_type: type, identity_value: value, match_reason: reason, confidence });
      return customerId;
    },
    async getCustomer(userId, id) {
      const c = customers.get(id);
      return c && c.user_id === userId ? c : null;
    },
    async updateCustomerFields(userId, id, f) {
      const c = customers.get(id);
      if (!c) return;
      for (const k of FIELDS) if (f[k] != null && c[k] == null) c[k] = f[k];
    },
    async mergeCustomers(userId, keepId, mergeId, reason, matchedOn) {
      for (const i of identities) if (i.customer_id === mergeId) i.customer_id = keepId;
      const keep = customers.get(keepId); const merged = customers.get(mergeId);
      for (const k of FIELDS) if (keep[k] == null && merged[k] != null) keep[k] = merged[k];
      merges.push({ keepId, mergeId, reason, matchedOn });
      customers.delete(mergeId);
    },
  };
}

test('new WhatsApp signal creates a customer', async () => {
  const store = memStore();
  const r = await resolveCustomer('u1', { whatsappSender: '966501234567@s.whatsapp.net', phone: '0501234567' }, { store });
  assert.equal(r.created, true);
  assert.equal(r.matchedBy, 'new');
  assert.equal(store.customers.size, 1);
  assert.equal(store.customers.get(r.customerId).canonical_phone, '966501234567');
});

test('same phone in a different form resolves to the SAME customer (no dup)', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { whatsappSender: '966501234567@s.whatsapp.net', phone: '0501234567' }, { store });
  const b = await resolveCustomer('u1', { phone: '+966 50 123 4567' }, { store });
  assert.equal(b.created, false);
  assert.equal(a.customerId, b.customerId);
  assert.equal(store.customers.size, 1);
});

test('Salla customer with same phone links onto the existing WhatsApp customer', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { whatsappSender: 'x@s.whatsapp.net', phone: '0501234567' }, { store });
  const b = await resolveCustomer('u1', { sallaCustomerId: '18292', phone: '966501234567' }, { store });
  assert.equal(a.customerId, b.customerId);
  assert.equal(b.matchedBy, 'phone');
  assert.equal(store.customers.get(a.customerId).salla_customer_id, '18292');
  // A later Salla event keyed only by salla id finds the same customer.
  const c = await resolveCustomer('u1', { sallaCustomerId: '18292' }, { store });
  assert.equal(c.customerId, a.customerId);
  assert.equal(store.customers.size, 1);
});

test('multi-tenant: same phone under two merchants stays two customers', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { phone: '0501234567' }, { store });
  const b = await resolveCustomer('u2', { phone: '0501234567' }, { store });
  assert.notEqual(a.customerId, b.customerId);
  assert.equal(store.customers.size, 2);
});

test('lid-only then a signal carrying lid+phone links them (no dup)', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { whatsappLid: '111222333@lid' }, { store });
  assert.equal(store.customers.size, 1);
  const b = await resolveCustomer('u1', { whatsappLid: '111222333@lid', phone: '0501234567' }, { store });
  assert.equal(a.customerId, b.customerId);
  assert.equal(store.customers.get(a.customerId).canonical_phone, '966501234567');
  // Now a phone-only signal finds the same customer.
  const c = await resolveCustomer('u1', { phone: '0501234567' }, { store });
  assert.equal(c.customerId, a.customerId);
  assert.equal(store.customers.size, 1);
});

test('two strong keys pointing at different customers auto-merge into one', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { phone: '0501234567' }, { store });          // customer A (phone)
  const b = await resolveCustomer('u1', { sallaCustomerId: '900' }, { store });         // customer B (salla)
  assert.notEqual(a.customerId, b.customerId);
  assert.equal(store.customers.size, 2);
  // A signal proving they are the same person (carries both keys) → merge.
  const m = await resolveCustomer('u1', { phone: '0501234567', sallaCustomerId: '900' }, { store });
  assert.equal(store.customers.size, 1);
  assert.equal(store.merges.length, 1);
  assert.equal(m.customerId, store.merges[0].keepId);
});

test('email alone NEVER merges two different phones (records a suggestion instead)', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { phone: '0501111111', email: 'shared@x.com' }, { store });
  const b = await resolveCustomer('u1', { phone: '0502222222', email: 'shared@x.com' }, { store });
  assert.notEqual(a.customerId, b.customerId, 'must NOT glue two phones via a shared email');
  assert.equal(store.customers.size, 2);
  assert.equal(store.merges.length, 0);
  assert.ok(b.suggestions.some((s) => s.type === 'email'), 'should flag the email conflict as a suggestion');
});

test('email-only match (no phone in signal) links to the existing customer', async () => {
  const store = memStore();
  const a = await resolveCustomer('u1', { phone: '0501234567', email: 'solo@x.com' }, { store });
  const b = await resolveCustomer('u1', { email: 'solo@x.com' }, { store });
  assert.equal(a.customerId, b.customerId);
  assert.equal(b.matchedBy, 'email');
  assert.equal(store.customers.size, 1);
});
