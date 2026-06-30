'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeArabic,
  detectEditCommand,
  isYes,
  isNo,
} = require('../lib/prompt-edit-keywords');

test('normalizeArabic unifies alef/hamza, ta-marbuta, alef-maqsura, strips tashkeel', () => {
  assert.equal(normalizeArabic('عدّل'), 'عدل');
  assert.equal(normalizeArabic('أضِفْ'), 'اضف');
  assert.equal(normalizeArabic('  البرومنت  '), 'البرومنت');
});

test('detectEditCommand matches each keyword and returns the body', () => {
  assert.deepEqual(detectEditCommand('تعديل: أضف إننا نوصل للرياض مجاناً'),
    { matched: true, body: 'أضف إننا نوصل للرياض مجاناً' });
  assert.deepEqual(detectEditCommand('عدّل سياسة الإرجاع 7 أيام'),
    { matched: true, body: 'سياسة الإرجاع 7 أيام' });
  assert.equal(detectEditCommand('ضيف اننا نشحن لكل المدن').matched, true);
  assert.equal(detectEditCommand('برومنت غيّر اسم الموظف').matched, true);
});

test('detectEditCommand tolerates a one-letter typo in the keyword', () => {
  assert.equal(detectEditCommand('تعدي أضف معلومة').matched, true); // missing letter
  assert.equal(detectEditCommand('تعدييل أضف معلومة').matched, true); // extra letter
});

test('detectEditCommand returns matched:false with empty body for a lone keyword', () => {
  assert.deepEqual(detectEditCommand('تعديل'), { matched: true, body: '' });
});

test('detectEditCommand does NOT match an unrelated message', () => {
  assert.equal(detectEditCommand('صباح الخير يا شباب').matched, false);
  assert.equal(detectEditCommand('تم حل المشكلة للعميل').matched, false);
});

test('isYes / isNo detect Arabic confirmations and tolerate typos', () => {
  assert.equal(isYes('نعم'), true);
  assert.equal(isYes('اي'), true);
  assert.equal(isYes('تمام'), true);
  assert.equal(isYes('نعمم'), true); // typo
  assert.equal(isYes('لا'), false);
  assert.equal(isNo('لا'), true);
  assert.equal(isNo('الغاء'), true);
  assert.equal(isNo('نعم'), false);
});
