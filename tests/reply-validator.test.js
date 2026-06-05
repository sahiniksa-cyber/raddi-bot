'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceLength } = require('../src/services/ai/reply-validator');

test('enforceLength keeps short replies untouched', () => {
  assert.equal(enforceLength('رد قصير', 300), 'رد قصير');
});

test('enforceLength truncates at sentence boundary when over limit', () => {
  const long = 'الجملة الأولى مفيدة. الجملة الثانية زائدة جداً وتتجاوز الحد المسموح به كثيراً جداً.';
  const out = enforceLength(long, 30);
  assert.ok(out.length <= 32, `len=${out.length}`);
  assert.ok(out.startsWith('الجملة الأولى'));
});

test('enforceLength hard-cuts when no sentence boundary', () => {
  const out = enforceLength('كلمةطويلةجدا'.repeat(20), 30);
  assert.ok(out.length <= 31);
});

const { enforceEscalationTag, detectEscalationIntent } = require('../src/services/ai/reply-validator');

const ESC_CONFIG = { escalationContacts: [{ name: 'المالك', phone: '0500000000' }] };

test('detectEscalationIntent true for explicit human request', () => {
  assert.equal(detectEscalationIntent('أبي أكلم المدير'), true);
  assert.equal(detectEscalationIntent('ودي أتواصل مع موظف'), true);
});
test('detectEscalationIntent false for normal question', () => {
  assert.equal(detectEscalationIntent('وش عندكم قهوة؟'), false);
});
test('enforceEscalationTag appends tag when intent present but tag missing', () => {
  const out = enforceEscalationTag('تمام بسجل طلبك ويتواصل معك المختص.', ESC_CONFIG, 'أبي أكلم المدير');
  assert.match(out, /\[تحويل:/);
});
test('enforceEscalationTag does nothing when tag already present', () => {
  const r = 'تمام. [تحويل:المالك|طلب تواصل]';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'أبي أكلم المدير'), r);
});
test('enforceEscalationTag does nothing when no intent', () => {
  const r = 'القهوة متوفرة عندنا.';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'وش عندكم قهوة؟'), r);
});
