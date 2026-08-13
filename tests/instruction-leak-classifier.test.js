'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyInstructionLine } = require('../scripts/detect-operational-instruction-leaks');

// Generic, tenant-agnostic examples (no ProStore/Adobe hardcoding). The classifier
// flags OPERATIONAL content leaked into free-text fields and proposes its structured home.

test('escalation directive (verb + target) → ESCALATION, high confidence, leak', () => {
  const r = classifyInstructionLine('لو العميل سأل عن الاسترجاع حوّله لمسؤول خدمة العملاء');
  assert.equal(r.category, 'ESCALATION');
  assert.equal(r.isLeak, true);
  assert.ok(r.confidence >= 0.7);
  assert.match(r.proposedTarget, /escalation/i);
});

test('routing to a bare NAME (no structured target yet) → ESCALATION leak, not POLICY', () => {
  const r = classifyInstructionLine('حوّل أسئلة الاسترجاع لسعود');
  assert.equal(r.category, 'ESCALATION');
  assert.equal(r.isLeak, true);
  assert.ok(r.confidence >= 0.6);
});

test('action verb → ACTION, leak (not executed until a real tool succeeds)', () => {
  const r = classifyInstructionLine('إذا طلب الإلغاء ألغِ الطلب وأرسل له تأكيد');
  assert.equal(r.category, 'ACTION');
  assert.equal(r.isLeak, true);
});

test('SLA time promise → SLA_TIME, leak, computable policy', () => {
  const r = classifyInstructionLine('التفعيل خلال 12 ساعة من الدفع');
  assert.equal(r.category, 'SLA_TIME');
  assert.equal(r.isLeak, true);
  assert.equal(r.severity, 'high');
});

test('prohibition → PROHIBITION, leak', () => {
  const r = classifyInstructionLine('ممنوع تعطي العميل أي سعر غير مؤكد');
  assert.equal(r.category, 'PROHIBITION');
  assert.equal(r.isLeak, true);
});

test('pure style/persona → STYLE, NOT a leak (belongs in botInstructions)', () => {
  const r = classifyInstructionLine('كن ودود ومختصر واستخدم لهجة سعودية خفيفة');
  assert.equal(r.category, 'STYLE');
  assert.equal(r.isLeak, false);
});

test('escalationConditions field: unclassified line is treated as an escalation-policy candidate', () => {
  const r = classifyInstructionLine('العملاء المميزون', { field: 'escalationConditions' });
  assert.equal(r.category, 'ESCALATION');
  assert.equal(r.isLeak, true);
});

test('empty / trivial lines are skipped', () => {
  assert.equal(classifyInstructionLine(''), null);
  assert.equal(classifyInstructionLine('  '), null);
});
