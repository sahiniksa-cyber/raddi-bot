'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRoutingDecision } = require('../src/services/instruction-routing/routing-apply');

test('resolved escalation → stores a structured rule in config.escalationRules (not botInstructions)', () => {
  const decision = {
    sink: 'escalationRule', op: 'add', resolved: true,
    targetContactId: 'c-77', targetName: 'سعود',
    trigger: { trigger_type: 'topic', trigger_value: 'الاسترجاع' },
  };
  const out = applyRoutingDecision(decision, { escalationRules: [] });
  assert.equal(out.stored, true);
  assert.equal(out.field, 'escalationRules');
  assert.equal(out.value.length, 1);
  assert.equal(out.value[0].target_contact_id, 'c-77');
  assert.equal(out.value[0].trigger_type, 'topic');
  assert.equal(out.value[0].trigger_value, 'الاسترجاع');
  assert.ok(out.merchantReply.includes('سعود'));
  assert.notEqual(out.field, 'botInstructions');
});

test('needs_target_setup → NO store, asks the merchant to finish the target setup', () => {
  const out = applyRoutingDecision(
    { sink: 'escalation', op: 'needs_target_setup', resolved: false, targetName: 'سعود' },
    {},
  );
  assert.equal(out.stored, false);
  assert.equal(out.field, null);
  assert.match(out.merchantReply, /سعود/);
  assert.match(out.merchantReply, /رقم|قروب|إعداد/);
});

test('needs_clarification → NO store, asks to clarify', () => {
  const out = applyRoutingDecision({ sink: 'escalation', op: 'needs_clarification', reason: 'no_target' }, {});
  assert.equal(out.stored, false);
  assert.equal(out.field, null);
  assert.ok(out.merchantReply.length > 0);
});

test('STYLE → appends to botInstructions (persona) — the only sink allowed there', () => {
  const out = applyRoutingDecision(
    { sink: 'botInstructions', op: 'append_persona', line: 'كن مختصر' },
    { botInstructions: 'رحّب بالعميل' },
  );
  assert.equal(out.stored, true);
  assert.equal(out.field, 'botInstructions');
  assert.ok(out.value.includes('رحّب بالعميل'));
  assert.ok(out.value.includes('كن مختصر'));
});

test('SLA → structured config.slaPolicies with the computed duration', () => {
  const out = applyRoutingDecision(
    { sink: 'slaPolicy', op: 'add', duration: { amount: 12, unit: 'ساعة' }, line: 'التفعيل خلال 12 ساعة' },
    {},
  );
  assert.equal(out.field, 'slaPolicies');
  assert.equal(out.value[0].amount, 12);
  assert.equal(out.stored, true);
});

test('operational categories NEVER land in botInstructions (policy/action/prohibition)', () => {
  for (const [sink, field] of [['policy', 'tenantPolicies'], ['actionPolicy', 'actionRequests'], ['avoidPhrases', 'prohibitions']]) {
    const out = applyRoutingDecision({ sink, op: 'add', line: 'x', requiresTool: true }, {});
    assert.notEqual(out.field, 'botInstructions');
    assert.equal(out.field, field);
    assert.equal(out.stored, true);
  }
});

test('review sink (UNKNOWN/low-confidence) → NO store, clarification', () => {
  const out = applyRoutingDecision({ sink: 'review', op: 'needs_clarification', reason: 'unclassified' }, {});
  assert.equal(out.stored, false);
  assert.equal(out.field, null);
});
