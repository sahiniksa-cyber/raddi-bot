'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStateTrace, validateState } = require('../src/services/ai/conversation-state');

test('buildStateTrace emits diagnostic fields and NO secrets/PII (§27)', () => {
  const state = validateState({
    active_topic: 'اشتراك Adobe',
    active_entities: [
      { type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe صاحبه محمد', last_seen: '3' },
      { type: 'payment_method', ref: 'tamara', label: 'تمارا', last_seen: '5' },
    ],
    known_facts: { الجوال: '0551234567', email: 'a@b.com' },
    pending_expectation: { type: 'phone_number', purpose: 'إرسال طلب الدفع' },
    last_turn_understanding: {
      intent: 'ask_warranty',
      resolved_references: [{ text: 'الاشتراك', entity: 'اشتراك Adobe', confidence: 'high' }],
    },
    salient_memories: [{ summary: 'يريد السنوي', source: 'customer' }],
  });
  const trace = buildStateTrace(state, {
    tenantId: 'u1', conversationId: 'c1', stateVersion: 4, extractionOk: true, contextBlockSize: 812,
  });

  assert.equal(trace.tenant_id, 'u1');
  assert.equal(trace.conversation_id, 'c1');
  assert.equal(trace.state_version, 4);
  assert.equal(trace.extraction_ok, true);
  assert.equal(trace.intent, 'ask_warranty');
  assert.equal(trace.active_topic, 'اشتراك Adobe');
  assert.equal(trace.active_entity, 'payment_method:tamara'); // type:ref, never the label
  assert.deepEqual(trace.active_entity_types.sort(), ['payment_method', 'subscription']);
  assert.equal(trace.resolved_references, 1);
  assert.equal(trace.pending_expectation, 'phone_number');
  assert.equal(trace.known_facts_count, 2);
  assert.equal(trace.memories_selected, 1);
  assert.equal(trace.context_block_size, 812);

  // Nothing sensitive anywhere in the serialised trace.
  const json = JSON.stringify(trace);
  assert.ok(!json.includes('0551234567'), 'no phone number');
  assert.ok(!json.includes('a@b.com'), 'no email');
  assert.ok(!json.includes('محمد'), 'no label/name leakage');
  assert.ok(!json.includes('إرسال طلب الدفع'), 'no free-text purpose leakage');
});

test('buildStateTrace is safe on a null/empty state', () => {
  const t = buildStateTrace(null, { tenantId: 'u', conversationId: 'c', extractionOk: false });
  assert.equal(t.extraction_ok, false);
  assert.equal(t.active_entity, null);
  assert.equal(t.resolved_references, 0);
});
