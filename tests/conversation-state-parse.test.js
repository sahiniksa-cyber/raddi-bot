'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPTY_STATE, validateState, parseExtractionResponse,
} = require('../src/services/ai/conversation-state');

test('EMPTY_STATE has all generic slots (V2 superset) and no vertical vocabulary', () => {
  assert.deepEqual(Object.keys(EMPTY_STATE).sort(), [
    'actions_attempted', 'active_entities', 'active_entity', 'active_topic', 'customer_goal',
    'known_facts', 'last_reply_intent', 'last_turn_understanding', 'open_issues',
    'pending_expectation', 'recent_topics', 'resolved_issues', 'salient_memories', 'schema_version',
  ]);
  assert.deepEqual(EMPTY_STATE.open_issues, []);
  assert.equal(EMPTY_STATE.active_topic, null);
});

test('validateState coerces a well-formed object and drops unknown keys', () => {
  const out = validateState({
    open_issues: [{ id: 'iss_1', summary: 'login fails', status: 'open' }],
    resolved_issues: [],
    active_topic: 'login',
    active_entity: { type: 'product', ref: 'x', label: 'X' },
    known_facts: { payment_method: 'bank_transfer' },
    customer_goal: 'access account',
    actions_attempted: [{ action: 'reset pw', outcome: 'unknown', confirmed_by: null }],
    last_reply_intent: 'ask_for_email',
    HACK: 'drop me',
  });
  assert.equal(out.HACK, undefined);
  assert.equal(out.open_issues[0].summary, 'login fails');
  assert.equal(out.active_entity.type, 'product');
  assert.equal(out.known_facts.payment_method, 'bank_transfer');
});

test('validateState repairs bad types into EMPTY_STATE defaults', () => {
  const out = validateState({ open_issues: 'nope', active_entity: 5, known_facts: [1, 2] });
  assert.deepEqual(out.open_issues, []);
  assert.equal(out.active_entity, null);
  assert.deepEqual(out.known_facts, {});
});

test('parseExtractionResponse returns extraction_ok=false on non-JSON', () => {
  const { state, extraction_ok } = parseExtractionResponse('sorry I cannot');
  assert.equal(extraction_ok, false);
  assert.deepEqual(state, EMPTY_STATE);
});

test('parseExtractionResponse strips code fences and validates', () => {
  const raw = '```json\n{"active_topic":"shipping","open_issues":[],"resolved_issues":[]}\n```';
  const { state, extraction_ok } = parseExtractionResponse(raw);
  assert.equal(extraction_ok, true);
  assert.equal(state.active_topic, 'shipping');
});
