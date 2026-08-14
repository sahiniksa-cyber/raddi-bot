'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeInstruction } = require('../src/services/instruction-routing/instruction-router');
const { classifyInstructionLine } = require('../src/services/instruction-routing/instruction-classifier');

function route(line, config) {
  return routeInstruction(classifyInstructionLine(line), config || {});
}

test('STYLE → persona sink (the only thing kept in botInstructions)', () => {
  assert.equal(route('كن ودود ومختصر').sink, 'botInstructions');
});

test('ESCALATION to an EXISTING resolvable contact → structured escalation rule', () => {
  const config = { escalationContacts: [{ name: 'سعود', phone: '966500000000' }] };
  const d = route('لو سأل عن الاسترجاع حوّله لسعود', config);
  assert.equal(d.sink, 'escalationRule');
  assert.equal(d.op, 'add');
  assert.equal(d.resolved, true);
  assert.equal(d.targetName, 'سعود');
  assert.ok(d.condition && d.condition.length > 0); // captured "الاسترجاع"/"سأل عن..."
});

test('ESCALATION to a NAMED but UNRESOLVABLE target → needs_target_setup (NOT silent, NOT a promise)', () => {
  const config = { escalationContacts: [] }; // سعود has no destination on file
  const d = route('حوّل أسئلة الفواتير لسعود', config);
  assert.equal(d.sink, 'escalation');
  assert.equal(d.op, 'needs_target_setup');
  assert.equal(d.resolved, false);
  assert.equal(d.targetName, 'سعود');
});

test('ESCALATION with NO target named → needs_clarification', () => {
  const d = route('صعّد المشكلة', {});
  assert.equal(d.sink, 'escalation');
  assert.equal(d.op, 'needs_clarification');
});

test('SLA_TIME → structured computable policy with extracted duration', () => {
  const d = route('التفعيل خلال 12 ساعة من الدفع', {});
  assert.equal(d.sink, 'slaPolicy');
  assert.equal(d.duration.amount, 12);
  assert.match(d.duration.unit, /ساع/);
});

test('PROHIBITION → avoid-phrases sink', () => {
  assert.equal(route('ممنوع تعطي سعر غير مؤكد', {}).sink, 'avoidPhrases');
});

test('ACTION → action policy flagged as requiring a real tool (no tool layer yet)', () => {
  const d = route('ألغِ الطلب وأرسل تأكيد', {});
  assert.equal(d.sink, 'actionPolicy');
  assert.equal(d.requiresTool, true);
});

test('null/empty segment → null routing', () => {
  assert.equal(routeInstruction(null, {}), null);
});
