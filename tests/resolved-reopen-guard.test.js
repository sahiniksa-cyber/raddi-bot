'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectResolvedReopen } = require('../src/services/ai/conversation-state');

const resolved = [{ id: 'i1', summary: 'تسجيل الدخول للحساب', resolved_by: 'customer_confirmed' }];

test('reopen detected: reply re-suggests steps for a resolved issue the customer did NOT re-raise', () => {
  const reply = 'عشان تسجل الدخول للحساب، سوي إعادة تعيين كلمة المرور وجرب مرة ثانية';
  const customer = 'طيب والفاتورة متى توصل؟';
  const out = detectResolvedReopen(reply, resolved, customer);
  assert.equal(out.reopened, true);
  assert.equal(out.issue, 'تسجيل الدخول للحساب');
});

test('NOT a reopen when the customer re-raised the same issue (legit re-answer)', () => {
  const reply = 'جرب تسجيل الدخول للحساب مرة ثانية';
  const customer = 'ما اقدر اسوي تسجيل الدخول للحساب من جديد';
  assert.equal(detectResolvedReopen(reply, resolved, customer).reopened, false);
});

test('NOT a reopen when the reply is unrelated to the resolved issue', () => {
  const reply = 'الشحن يوصل خلال ثلاثة ايام ان شاء الله';
  const customer = 'كم يستغرق الشحن؟';
  assert.equal(detectResolvedReopen(reply, resolved, customer).reopened, false);
});

test('empty / missing resolved issues → never a reopen', () => {
  assert.equal(detectResolvedReopen('اي رد', [], 'اي سؤال').reopened, false);
  assert.equal(detectResolvedReopen('اي رد', null, 'اي سؤال').reopened, false);
});
