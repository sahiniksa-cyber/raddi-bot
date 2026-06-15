'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isCopOut, enforceEscalationTag } = require('../src/services/ai/reply-validator');

const CONTACTS = { escalationContacts: [{ name: 'المالك', phone: '0500000000' }] };

// ── #2: detect the deflect-and-return-later cop-out family ───────────
test('isCopOut detects "بأراجع الموضوع وأكلمك"', () => {
  assert.equal(isCopOut('بأراجع الموضوع وأكلمك'), true);
});
test('isCopOut detects "لحظات أراجع وأكلمك"', () => {
  assert.equal(isCopOut('لحظات أراجع وأكلمك'), true);
});
test('isCopOut detects "خلّي أراجع المختص ويرجع لك خلال ساعة"', () => {
  assert.equal(isCopOut('خلّي أراجع المختص ويرجع لك خلال ساعة'), true);
});
test('isCopOut negative control: a real answer with "أرجع لك" is NOT a cop-out', () => {
  assert.equal(isCopOut('أرجع لك السعر هو 250 ريال'), false);
});

// ── #3: a detected cop-out must force a real escalation tag ──────────
test('enforceEscalationTag forces a tag on a deflection cop-out when a contact exists', () => {
  const out = enforceEscalationTag('بأراجع الموضوع وأكلمك', CONTACTS, 'كم سعر الاشتراك السنوي؟');
  assert.match(out, /\[تحويل:[^\]]*\]\s*$/, `expected an escalation tag, got: ${out}`);
});
test('no escalation contact configured → reply returned unchanged (cannot escalate)', () => {
  const out = enforceEscalationTag('بأراجع الموضوع وأكلمك', { escalationContacts: [] }, 'كم السعر؟');
  assert.equal(out, 'بأراجع الموضوع وأكلمك');
});
test('cop-out that asks the customer for info is NOT auto-escalated (contradiction guard kept)', () => {
  const reply = 'عشان أراجع لك وأرجع لك، ممكن رقم الطلب؟';
  const out = enforceEscalationTag(reply, CONTACTS, 'وش صار على طلبي؟');
  assert.equal(out, reply, 'must not escalate while asking the customer for info');
});
test('a normal complete answer is NOT escalated', () => {
  const reply = 'السعر 250 ريال ويشمل التوصيل.';
  const out = enforceEscalationTag(reply, CONTACTS, 'كم السعر؟');
  assert.equal(out, reply);
});
