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

// Production 2026-07-02 (screenshot): "الو" was mis-read as "إلغاء" and canceled
// a pending edit, and natural confirmations like "تم اكد" were not recognized so
// the edit never applied.
test('isYes recognizes natural multi-word confirmations', () => {
  assert.equal(isYes('تم اكد'), true);
  assert.equal(isYes('تم التاكيد'), true);
  assert.equal(isYes('ابغى اكد'), true);
  assert.equal(isYes('اكد'), true);
  assert.equal(isYes('نعم اكيد'), true);
  assert.equal(isYes('تم'), true);
});

test('isNo does NOT fire on "الو" or on a long sentence that merely contains a stop-ish word', () => {
  assert.equal(isNo('الو'), false, '"الو" must never be read as cancel');
  assert.equal(isYes('الو'), false);
  // the merchant\'s long instruction sentence must not be read as yes/no
  const longSentence = 'احتاج منك تاكيد انه اي كلام مثل اذا تحتاج اي شيء ثاني انا موجود ما يقولها ابدا';
  assert.equal(isNo(longSentence), false);
  assert.equal(isYes(longSentence), false);
});

test('isNo still catches real cancellations', () => {
  assert.equal(isNo('لا'), true);
  assert.equal(isNo('الغاء'), true);
  assert.equal(isNo('الغي'), true);
  assert.equal(isNo('تراجع'), true);
  assert.equal(isNo('لا خلاص'), true);
});
