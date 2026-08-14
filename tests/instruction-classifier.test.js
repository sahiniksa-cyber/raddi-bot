'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyInstructionLine, classifyInstruction, CATEGORIES,
} = require('../src/services/instruction-routing/instruction-classifier');

// Generic, tenant-agnostic classification (no ProStore/Adobe hardcoding). The
// routing layer uses this to send each merchant edit to its correct structured
// home instead of dumping everything into the free-text prompt.

test('CATEGORIES are the seven platform routing buckets', () => {
  assert.deepEqual([...CATEGORIES].sort(), [
    'ACTION', 'ESCALATION', 'KNOWLEDGE', 'POLICY', 'PROHIBITION', 'SLA_TIME', 'STYLE',
  ]);
});

test('escalation/routing intent → ESCALATION (operational, leaves the prompt)', () => {
  const r = classifyInstructionLine('لو العميل سأل عن الاسترجاع حوّله لمسؤول خدمة العملاء');
  assert.equal(r.category, 'ESCALATION');
  assert.equal(r.isOperational, true);
});

test('routing to a bare name still → ESCALATION (the silent-cancel leak case)', () => {
  assert.equal(classifyInstructionLine('حوّل أسئلة الفواتير لسعود').category, 'ESCALATION');
});

test('action verb → ACTION (not executed until a real tool succeeds)', () => {
  assert.equal(classifyInstructionLine('إذا طلب الإلغاء ألغِ الطلب وأرسل تأكيد').category, 'ACTION');
});

test('SLA time promise → SLA_TIME (computable policy)', () => {
  const r = classifyInstructionLine('التفعيل خلال 12 ساعة من الدفع');
  assert.equal(r.category, 'SLA_TIME');
  assert.equal(r.isOperational, true);
});

test('prohibition beats a stray action verb in the same line', () => {
  assert.equal(classifyInstructionLine('ممنوع تعطي العميل سعر غير مؤكد').category, 'PROHIBITION');
});

test('pure persona/style → STYLE (the ONLY thing that belongs in botInstructions)', () => {
  const r = classifyInstructionLine('كن ودود ومختصر واستخدم لهجة سعودية خفيفة');
  assert.equal(r.category, 'STYLE');
  assert.equal(r.isOperational, false);
});

test('classifyInstruction splits a mixed edit into per-segment routing decisions', () => {
  const segs = classifyInstruction('كن مختصر، ولو سأل عن الاسترجاع حوّله لسعود');
  const cats = segs.map(s => s.category);
  assert.ok(cats.includes('STYLE'));
  assert.ok(cats.includes('ESCALATION'));
});

test('classifyInstruction: dominantOperational flags whether any operational segment exists', () => {
  const styleOnly = classifyInstruction('اكتب بأسلوب مهذب ومختصر');
  assert.equal(styleOnly.some(s => s.isOperational), false);
  const withOps = classifyInstruction('رحّب بالعميل. صعّد شكاوى الدفع للفريق');
  assert.equal(withOps.some(s => s.isOperational), true);
});
