'use strict';

/**
 * Identity resolution — maps an incoming signal (a WhatsApp message, a Salla
 * customer/order/cart event, or a sync row) to ONE canonical customer, creating
 * or merging as the evidence warrants. This is where duplicate-prevention lives.
 *
 * Priority (never by name):
 *   salla_customer_id (confirmed) > canonical phone (strong) >
 *   whatsapp_sender / whatsapp_lid / email (weak).
 *
 * Rules:
 *  - A signal carrying two STRONG keys that point at two existing customers
 *    proves they are the same person → auto-merge (audited).
 *  - A weak key (email/lid) is used as the base ONLY when the signal has no
 *    strong key at all. Never glue two different phones together via a shared
 *    email — that becomes a *suggestion*, not a merge.
 *  - Keys are linked to the base customer, except a weak key already owned by a
 *    different customer (left alone; surfaced as a suggestion).
 *
 * Pure algorithm over an injectable `store` (see customer-store.js) so it is
 * unit-tested without a database.
 */

const { toCanonicalPhone } = require('./phone');
let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = require('./customer-store');
  return defaultStore;
}

// Confidence per identity type (also the strength ordering).
const CONFIDENCE = Object.freeze({
  salla_customer_id: 1,
  phone: 0.95,
  whatsapp_sender: 0.9,
  whatsapp_lid: 0.6,
  email: 0.5,
});

async function resolveCustomer(userId, signal = {}, deps = {}) {
  const store = deps.store || getDefaultStore();
  const phoneOpts = deps.phoneOpts;

  const canonical = signal.canonicalPhone
    || (signal.phone ? (toCanonicalPhone(signal.phone, phoneOpts) || {}).canonical || null : null);
  const email = signal.email ? String(signal.email).trim().toLowerCase() : null;
  const sallaId = signal.sallaCustomerId != null ? String(signal.sallaCustomerId) : null;
  const waSender = signal.whatsappSender || null;
  const waLid = signal.whatsappLid || null;

  // Build lookup keys in priority order; `strong` marks confirmed/strong keys.
  const keys = [];
  if (sallaId) keys.push({ type: 'salla_customer_id', value: sallaId, strong: true });
  if (canonical) keys.push({ type: 'phone', value: canonical, strong: true });
  if (waSender) keys.push({ type: 'whatsapp_sender', value: waSender, strong: false });
  if (waLid) keys.push({ type: 'whatsapp_lid', value: waLid, strong: false });
  if (email) keys.push({ type: 'email', value: email, strong: false });

  const matched = [];
  for (const k of keys) {
    const customerId = await store.findCustomerIdByIdentity(userId, k.type, k.value);
    matched.push({ ...k, customerId });
  }

  const strongMatches = matched.filter((m) => m.strong && m.customerId);
  const strongIds = [...new Set(strongMatches.map((m) => m.customerId))];

  let baseId = null;
  let matchedBy = 'new';
  let created = false;

  if (strongIds.length >= 1) {
    // Prefer the customer matched by the highest-priority strong key (salla
    // before phone, per key order) as the survivor.
    baseId = strongMatches[0].customerId;
    matchedBy = strongMatches[0].type;
    for (const otherId of strongIds) {
      if (otherId === baseId) continue;
      await store.mergeCustomers(userId, baseId, otherId, 'multi_strong', {
        keys: strongMatches.map((m) => ({ type: m.type, value: m.value })),
      });
    }
  } else {
    // No strong MATCH. A weak match (lid/sender/email) may serve as the base,
    // BUT only if the signal's strong key does not CONFLICT with a strong
    // identity the candidate already owns — otherwise attaching would glue two
    // different people together (e.g. two phones sharing one email). A new,
    // unseen strong key on a candidate that has none yet is NOT a conflict.
    const weak = matched.find((m) => !m.strong && m.customerId);
    if (weak) {
      const cand = await store.getCustomer(userId, weak.customerId);
      const phoneConflict = Boolean(canonical && cand && cand.canonical_phone && cand.canonical_phone !== canonical);
      const sallaConflict = Boolean(sallaId && cand && cand.salla_customer_id && cand.salla_customer_id !== sallaId);
      if (!phoneConflict && !sallaConflict) {
        baseId = weak.customerId;
        matchedBy = weak.type;
      }
      // else: conflict → fall through to create a new customer; the weak key is
      // left with its current owner and surfaced as a suggestion below.
    }
  }

  const fields = {
    canonical_phone: canonical,
    email,
    salla_customer_id: sallaId,
    display_name: signal.name || null,
    first_seen_at: signal.occurredAt || null,
  };

  if (!baseId) {
    baseId = await store.createCustomer(userId, fields);
    created = true;
    matchedBy = 'new';
  } else {
    await store.updateCustomerFields(userId, baseId, fields);
  }

  // Link keys to the base; a weak key owned by a different customer is a
  // conflict → suggestion, not a steal.
  const suggestions = [];
  for (const m of matched) {
    if (m.customerId && m.customerId !== baseId && !m.strong) {
      suggestions.push({ type: m.type, value: m.value, otherCustomerId: m.customerId });
      continue;
    }
    await store.addIdentity(userId, baseId, m.type, m.value, signal.source || matchedBy, CONFIDENCE[m.type] || 0.5);
  }

  return { customerId: baseId, created, matchedBy, suggestions };
}

module.exports = { resolveCustomer, CONFIDENCE };
