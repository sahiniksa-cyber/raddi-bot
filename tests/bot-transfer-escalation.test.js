'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { botSignalsTransfer, enforceEscalationTag } = require('../src/services/ai/reply-validator');

test('botSignalsTransfer detects the bot\'s own transfer phrases', () => {
  assert.equal(botSignalsTransfer('رح أحوّل طلبك للفريق الحين 🙂 وبيتواصلون معك'), true);
  assert.equal(botSignalsTransfer('رح يتواصل معك فريقنا في أقرب وقت'), true);
  assert.equal(botSignalsTransfer('تمام، وصلت التفاصيل. رح أحوّل طلبك للفريق'), true);
});

test('botSignalsTransfer is false for a normal answer', () => {
  assert.equal(botSignalsTransfer('سعر أدوبي لمدة شهر 59 ريال'), false);
  assert.equal(botSignalsTransfer('وش لون سيارتك الحالي؟'), false);
});

test('enforceEscalationTag appends marker when the BOT signals a transfer (no explicit customer request)', () => {
  const cfg = { escalationContacts: [{ name: 'الفريق', phone: '0562529945' }] };
  const out = enforceEscalationTag('رح أحوّل طلبك للفريق الحين وبيتواصلون معك', cfg, 'سليمة، كم بتكلف؟');
  assert.match(out, /\[تحويل:الفريق\|/);
});

test('enforceEscalationTag does NOT double-tag when a marker already exists', () => {
  const cfg = { escalationContacts: [{ name: 'الفريق' }] };
  const r = 'رح أحوّل طلبك [تحويل:الفريق|طلب دهان]';
  assert.equal(enforceEscalationTag(r, cfg, ''), r);
});

test('enforceEscalationTag adds nothing when there are no escalation contacts', () => {
  assert.equal(enforceEscalationTag('رح أحوّل طلبك للفريق', {}, ''), 'رح أحوّل طلبك للفريق');
});

test('normal reply (no transfer, no customer request) is untouched', () => {
  const cfg = { escalationContacts: [{ name: 'الفريق' }] };
  assert.equal(enforceEscalationTag('سعرها 59 ريال', cfg, 'بكم الشهر'), 'سعرها 59 ريال');
});
