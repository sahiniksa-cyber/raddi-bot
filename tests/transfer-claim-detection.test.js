'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { botSignalsTransfer, enforceEscalationTag } = require('../src/services/ai/reply-validator');

// Production failures 2026-06-11/12: the AI CLAIMED a transfer in phrasings
// outside the old narrow list, so no [تحويل:] tag was enforced and nothing
// reached the team — while the customer was told "رسلت للإدارة".

test('catches the real production transfer claims', () => {
  assert.equal(botSignalsTransfer('رسلت للإدارة وأنتظر ردهم، أول ما يوصلني خبر بأبلغك'), true, 'رسلت للإدارة');
  assert.equal(botSignalsTransfer('تمام، حولتك للفريق المختص'), true, 'حولتك للفريق');
  assert.equal(botSignalsTransfer('تم رفع طلبك للإدارة وبنرد عليك'), true, 'تم رفع للإدارة');
  assert.equal(botSignalsTransfer('أبلغت الفريق المختص بمشكلتك'), true, 'أبلغت الفريق');
  assert.equal(botSignalsTransfer('صعدت الموضوع للدعم الفني'), true, 'صعدت للدعم');
});

test('still catches the original phrasings', () => {
  assert.equal(botSignalsTransfer('بحوّلك، أحول طلبك الآن'), true);
  assert.equal(botSignalsTransfer('الفريق بيتواصل معك خلال ساعة'), true);
});

test('does NOT fire on ordinary replies (no false escalations)', () => {
  // NOTE 2026-06-12: "بنحل لك المشكلة" moved to the POSITIVE list by owner
  // request — a first-person promise to fix means the team must be looped in
  // at problem time (see bridge-final-fixes.test.js).
  assert.equal(botSignalsTransfer('أرسلت لك الكود على الواتساب'), false, 'send verb without team entity');
  assert.equal(botSignalsTransfer('الإدارة ترحب بك في متجرنا'), false, 'entity without transfer verb');
  assert.equal(botSignalsTransfer('تقدر تحل المشكلة بنفسك من الإعدادات'), false, 'second-person guidance');
  assert.equal(botSignalsTransfer('سعر الاشتراك 59 ريال'), false);
});

test('enforceEscalationTag appends the tag for the production phrase end-to-end', () => {
  const config = { escalationContacts: [{ name: 'الفني', phone: '21658466057' }] };
  const out = enforceEscalationTag('رسلت للإدارة وأنتظر ردهم', config, 'اي متى تنحل المشكلة ؟');
  assert.match(out, /\[تحويل:الفني\|/, `tag must be enforced, got: "${out}"`);
});
