'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateState, EMPTY_STATE } = require('../src/services/ai/conversation-state');

// ── Context Engine V2 state shape (backward-compatible superset of V1) ──────

test('EMPTY_STATE is schema_version 2 and carries every V2 slot', () => {
  assert.equal(EMPTY_STATE.schema_version, 2);
  assert.deepEqual(EMPTY_STATE.active_entities, []);
  assert.deepEqual(EMPTY_STATE.recent_topics, []);
  assert.deepEqual(EMPTY_STATE.salient_memories, []);
  assert.equal(EMPTY_STATE.pending_expectation, null);
  assert.deepEqual(EMPTY_STATE.last_turn_understanding, {
    intent: null, resolved_references: [], topic_transition: null, customer_correction: false,
  });
  // V1 slots still present (backward compatibility for old DB rows).
  for (const k of ['open_issues', 'resolved_issues', 'active_topic', 'active_entity',
    'known_facts', 'customer_goal', 'actions_attempted', 'last_reply_intent']) {
    assert.ok(k in EMPTY_STATE, `missing V1 slot ${k}`);
  }
});

test('validateState upgrades a V1 row (no V2 keys) to the V2 shape with empty defaults', () => {
  const out = validateState({
    open_issues: [{ id: 'i1', summary: 'login fails', status: 'open' }],
    active_topic: 'login',
    active_entity: { type: 'product', ref: 'x', label: 'X' },
    known_facts: { payment_method: 'bank_transfer' },
  });
  assert.equal(out.schema_version, 2);
  assert.deepEqual(out.active_entities, []);
  assert.deepEqual(out.recent_topics, []);
  assert.deepEqual(out.salient_memories, []);
  assert.equal(out.pending_expectation, null);
  // V1 data preserved untouched.
  assert.equal(out.open_issues[0].summary, 'login fails');
  assert.equal(out.active_entity.type, 'product');
  assert.equal(out.known_facts.payment_method, 'bank_transfer');
});

test('entity types are generic (not a closed whitelist) — subscription/payment_method accepted', () => {
  const out = validateState({
    active_entities: [
      { type: 'subscription', ref: 'adobe_cc', label: 'اشتراك Adobe', status: 'active', confidence: 'high', last_seen: 't5' },
      { type: 'payment_method', ref: 'tamara', label: 'تمارا', confidence: 'high', last_seen: 't6' },
    ],
  });
  assert.equal(out.active_entities.length, 2);
  const types = out.active_entities.map((e) => e.type).sort();
  assert.deepEqual(types, ['payment_method', 'subscription']);
  // stored newest-first (t6 > t5), so the payment method leads
  assert.equal(out.active_entities[0].type, 'payment_method');
});

test('active_entity is DERIVED from the newest active entity when not set explicitly (back-compat readers)', () => {
  const out = validateState({
    active_entities: [
      { type: 'product', ref: 'a', label: 'A', last_seen: '1' },
      { type: 'product', ref: 'b', label: 'B', last_seen: '9' },
    ],
  });
  // Newest by last_seen wins.
  assert.equal(out.active_entity.ref, 'b');
});

test('when active_entities exist, the newest V2 entity wins over a stale V1 active_entity', () => {
  const out = validateState({
    active_entity: { type: 'order', ref: 'o1', label: 'الطلب 1' }, // stale V1 field
    active_entities: [{ type: 'product', ref: 'a', label: 'A', last_seen: '9' }],
  });
  assert.equal(out.active_entity.type, 'product');
  assert.equal(out.active_entity.ref, 'a');
});

test('pending_expectation validated; garbage → null', () => {
  const ok = validateState({
    pending_expectation: { type: 'phone_number', purpose: 'payment request', related_entity: 'adobe_cc' },
  });
  assert.equal(ok.pending_expectation.type, 'phone_number');
  assert.equal(ok.pending_expectation.purpose, 'payment request');
  const bad = validateState({ pending_expectation: 5 });
  assert.equal(bad.pending_expectation, null);
  const noType = validateState({ pending_expectation: { purpose: 'x' } });
  assert.equal(noType.pending_expectation, null); // type is required
});

test('salient_memories validated; entries without a summary dropped', () => {
  const out = validateState({
    salient_memories: [
      { summary: 'العميل يريد اشتراك Adobe سنوي', kind: 'choice', related_entities: ['adobe_cc'], source: 'customer', confidence: 'high' },
      { kind: 'noise' }, // no summary → dropped
    ],
  });
  assert.equal(out.salient_memories.length, 1);
  assert.equal(out.salient_memories[0].source, 'customer');
});

test('salient memory source is bounded; unknown/assistant source normalised (never silently "customer")', () => {
  const out = validateState({
    salient_memories: [
      { summary: 'x', source: 'assistant' },   // not a trusted source
      { summary: 'y', source: 'invented' },
    ],
  });
  assert.ok(['unknown', 'previous_bot_statement'].includes(out.salient_memories[0].source));
  assert.equal(out.salient_memories[1].source, 'unknown');
});

test('salient_memories are capped at 50 (highest-value kept, deterministic)', () => {
  const many = [];
  for (let i = 0; i < 70; i++) {
    many.push({ summary: `low ${i}`, source: 'unknown', confidence: 'low' });
  }
  many.push({ summary: 'KEEP-ME high value', source: 'customer', confidence: 'high' });
  const out = validateState({ salient_memories: many });
  assert.equal(out.salient_memories.length, 50);
  assert.ok(out.salient_memories.some(m => m.summary === 'KEEP-ME high value'),
    'a high-value memory must survive the cap');
});

test('last_turn_understanding.resolved_references validated', () => {
  const out = validateState({
    last_turn_understanding: {
      intent: 'ask_warranty',
      resolved_references: [
        { text: 'الاشتراك', entity: 'اشتراك Adobe', confidence: 'high' },
        { garbage: true }, // no text → dropped
      ],
      topic_transition: 'return',
      customer_correction: true,
    },
  });
  assert.equal(out.last_turn_understanding.intent, 'ask_warranty');
  assert.equal(out.last_turn_understanding.resolved_references.length, 1);
  assert.equal(out.last_turn_understanding.resolved_references[0].entity, 'اشتراك Adobe');
  assert.equal(out.last_turn_understanding.customer_correction, true);
});

test('recent_topics is a bounded array of strings', () => {
  const out = validateState({ recent_topics: ['Adobe', 'Tamara', 5, null, 'شحن'] });
  assert.deepEqual(out.recent_topics, ['Adobe', 'Tamara', 'شحن']);
});
