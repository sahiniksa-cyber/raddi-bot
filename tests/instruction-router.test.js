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

test('ESCALATION to an EXISTING resolvable contact → rule with STABLE target_contact_id + structured trigger', () => {
  const config = { escalationContacts: [{ id: 'c-77', name: 'سعود', phone: '966500000000' }] };
  const d = route('لو سأل عن الاسترجاع حوّله لسعود', config);
  assert.equal(d.sink, 'escalationRule');
  assert.equal(d.op, 'add');
  assert.equal(d.resolved, true);
  assert.equal(d.targetContactId, 'c-77');          // stable id, not just a name
  assert.equal(d.trigger.trigger_type, 'topic');    // structured trigger
  assert.equal(d.trigger.trigger_value, 'الاسترجاع');
});

test('resolvable contact WITHOUT an id → deterministic name-based stable id', () => {
  const config = { escalationContacts: [{ name: 'سعود', phone: '966500000000' }] };
  const d = route('حوّل أسئلة الفواتير لسعود', config);
  assert.equal(d.sink, 'escalationRule');
  assert.equal(d.targetContactId, 'name:سعود');
  assert.equal(d.trigger.trigger_type, 'topic');
  assert.equal(d.trigger.trigger_value, 'الفواتير');
});

test('ESCALATION to a NAMED but UNRESOLVABLE target → needs_target_setup (NOT silent, NOT a promise)', () => {
  const d = route('حوّل أسئلة الفواتير لسعود', { escalationContacts: [] });
  assert.equal(d.sink, 'escalation');
  assert.equal(d.op, 'needs_target_setup');
  assert.equal(d.resolved, false);
  assert.equal(d.targetName, 'سعود');
});

test('AMBIGUOUS target (two contacts share the exact name) → needs_clarification, store nothing', () => {
  const config = { escalationContacts: [
    { id: 'a', name: 'سعود', phone: '966500000001' },
    { id: 'b', name: 'سعود', phone: '966500000002' },
  ] };
  const d = route('حوّل الفواتير لسعود', config);
  assert.equal(d.sink, 'escalation');
  assert.equal(d.op, 'needs_clarification');
  assert.equal(d.reason, 'ambiguous_target');
});

test('exact-match only: a contact whose name merely CONTAINS the target is NOT chosen', () => {
  // "سعود" must not fuzzy-match "سعودية" — that would route to the wrong contact.
  const config = { escalationContacts: [{ id: 'x', name: 'سعودية', phone: '966500000000' }] };
  const d = route('حوّل الفواتير لسعود', config);
  assert.equal(d.op, 'needs_target_setup'); // no EXACT match → ask to set up, not misroute
});

test('ESCALATION with NO target named → needs_clarification', () => {
  const d = route('صعّد المشكلة', {});
  assert.equal(d.sink, 'escalation');
  assert.equal(d.op, 'needs_clarification');
  assert.equal(d.reason, 'no_target');
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

test('UNKNOWN/unclassified NEVER goes to botInstructions → needs_clarification', () => {
  const seg = classifyInstructionLine('الطقس جميل اليوم');
  assert.equal(seg.category, 'UNKNOWN');
  const d = routeInstruction(seg, {});
  assert.equal(d.sink, 'review');
  assert.equal(d.op, 'needs_clarification');
});

test('low-confidence classification → needs_clarification, stores nothing', () => {
  const seg = { category: 'ESCALATION', confidence: 0.2, line: 'حوّل لسعود' };
  const d = routeInstruction(seg, { escalationContacts: [{ name: 'سعود', phone: '9' }] });
  assert.equal(d.sink, 'review');
  assert.equal(d.op, 'needs_clarification');
  assert.equal(d.reason, 'low_confidence');
});

test('null/empty segment → null routing', () => {
  assert.equal(routeInstruction(null, {}), null);
});
