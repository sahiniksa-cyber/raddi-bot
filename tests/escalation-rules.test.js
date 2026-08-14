'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEscalationRules, resolveContactById } = require('../src/services/instruction-routing/escalation-rules');

const CONTACTS = [
  { id: 'c1', name: 'سعود', phone: '966500000000' },
  { name: 'الفريق', groupJid: '120@g.us' }, // no id → derived name:الفريق
];

test('topic rule fires when the inbound text contains the topic; resolves the target contact', () => {
  const config = { escalationContacts: CONTACTS, escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const r = evaluateEscalationRules(config, { text: 'أبغى أعرف سياسة الاسترجاع' });
  assert.equal(r.matched, true);
  assert.equal(r.contact.id, 'c1');
  assert.equal(r.unresolved, undefined);
});

test('no rule fires when the topic is absent', () => {
  const config = { escalationContacts: CONTACTS, escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  assert.equal(evaluateEscalationRules(config, { text: 'كم سعر المنتج؟' }).matched, false);
});

test('intent rule fires on a matching classified intent', () => {
  const config = { escalationContacts: CONTACTS, escalationRules: [{ target_contact_id: 'c1', trigger_type: 'intent', trigger_value: 'escalation_requested' }] };
  const r = evaluateEscalationRules(config, { text: 'أبي أكلم مسؤول', intent: 'escalation_requested' });
  assert.equal(r.matched, true);
  assert.equal(r.contact.id, 'c1');
});

test('a rule whose target is no longer resolvable → matched but unresolved (do NOT fire a broken escalation)', () => {
  const config = { escalationContacts: [], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const r = evaluateEscalationRules(config, { text: 'الاسترجاع' });
  assert.equal(r.matched, true);
  assert.equal(r.unresolved, true);
  assert.equal(r.contact, null);
});

test('resolveContactById matches both explicit ids and derived name: ids', () => {
  assert.equal(resolveContactById(CONTACTS, 'c1').id, 'c1');
  assert.equal(resolveContactById(CONTACTS, 'name:الفريق').name, 'الفريق');
  assert.equal(resolveContactById(CONTACTS, 'nope'), null);
});

test('no rules configured → not matched (safe default)', () => {
  assert.equal(evaluateEscalationRules({ escalationContacts: CONTACTS }, { text: 'أي شيء' }).matched, false);
});

const { applyDeterministicEscalation } = require('../src/services/instruction-routing/escalation-rules');

test('deterministic escalation: matched+resolved rule injects a [تحويل:] marker', () => {
  const config = { escalationContacts: [{ id: 'c1', name: 'سعود', phone: '9' }], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('تمام أساعدك.', config, { text: 'سؤال عن الاسترجاع' });
  assert.equal(out.escalated, true);
  assert.match(out.reply, /\[تحويل:سعود\|الاسترجاع\]/);
});

test('deterministic escalation: never double-marks if the model already escalated', () => {
  const config = { escalationContacts: [{ id: 'c1', name: 'سعود', phone: '9' }], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('رد [تحويل:سعود|شي]', config, { text: 'الاسترجاع' });
  assert.equal(out.escalated, false);
  assert.equal(out.alreadyMarked, true);
});

test('deterministic escalation: no match → reply unchanged', () => {
  const config = { escalationContacts: [{ id: 'c1', name: 'سعود', phone: '9' }], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('السعر 100', config, { text: 'كم السعر' });
  assert.equal(out.escalated, false);
  assert.equal(out.reply, 'السعر 100');
});

test('deterministic escalation: unresolved target does NOT fire (stays a setup task)', () => {
  const config = { escalationContacts: [], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('رد', config, { text: 'الاسترجاع' });
  assert.equal(out.escalated, false);
  assert.equal(out.unresolved, true);
});
