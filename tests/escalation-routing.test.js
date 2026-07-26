'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEscalationNotification,
  extractEscalationRequest,
  normalizeEscalationPhone,
  normalizeEscalationTarget,
  prepareEscalation,
  stripEscalationMarkers,
} = require('../src/workers/escalation-routing');
const { canonicalConfig } = require('./helpers/canonical-config');

function config() {
  return canonicalConfig({
    contacts: [{
      id: 'contact-owner',
      name: 'المالك',
      phoneNumber: '+966500000000',
    }],
  });
}

test('bare 16+ digit targets are treated as group IDs, shorter stay phones', () => {
  assert.equal(normalizeEscalationTarget('1234567890123456'), '1234567890123456@g.us');
  assert.equal(normalizeEscalationTarget('0500000000'), '966500000000@c.us');
});

test('extractEscalationRequest removes the private marker from customer reply', () => {
  const extracted = extractEscalationRequest('تم تسجيل طلبك [تحويل:contact-owner|مشكلة دفع]');
  assert.equal(extracted.customerReply, 'تم تسجيل طلبك');
  assert.equal(extracted.contactName, 'contact-owner');
});

test('only an exact canonical contact ID may create a handoff notification', () => {
  const routed = prepareEscalation({
    reply: 'تم [تحويل:contact-owner|مشكلة دفع]',
    config: config(),
    customerSender: '966511111111@s.whatsapp.net',
    customerPhoneNumber: '966511111111',
    inboundText: 'الدفع لا يعمل',
  });
  assert.equal(routed.customerReply, 'تم');
  assert.equal(routed.ownerMessage.sender, '966500000000@c.us');
  assert.match(routed.ownerMessage.reply, /966511111111/);
  assert.doesNotMatch(routed.customerReply, /contact-owner|تحويل/);
});

test('a contact name, legacy list, or unknown ID never guesses a destination', () => {
  for (const marker of ['المالك', 'unknown-id']) {
    const routed = prepareEscalation({
      reply: `تم [تحويل:${marker}|ملخص]`,
      config: {
        ...config(),
        escalationContacts: [{ name: 'المالك', phone: '0599999999' }],
      },
      customerSender: '966511111111@s.whatsapp.net',
      inboundText: 'أريد موظفًا',
    });
    assert.equal(routed.ownerMessage, null);
    assert.doesNotMatch(routed.customerReply, /تحويل/);
  }
});

test('missing or review-only policy fails closed without an owner message', () => {
  const routed = prepareEscalation({
    reply: 'تم [تحويل:contact-owner|ملخص]',
    config: { escalationContacts: [{ name: 'المالك', phone: '0599999999' }] },
    customerSender: '966511111111@s.whatsapp.net',
  });
  assert.equal(routed.ownerMessage, null);
});

test('normal replies never attempt routing and malformed markers are scrubbed', () => {
  assert.equal(prepareEscalation({
    reply: 'رد عادي',
    config: config(),
  }).ownerMessage, null);
  assert.equal(stripEscalationMarkers('رد [تحويل:broken'), 'رد');
});

test('notification contains customer and problem details', () => {
  const text = buildEscalationNotification({
    contact: { name: 'المالك' },
    customerSender: '966511111111@s.whatsapp.net',
    inboundText: 'مشكلة في الدفع',
    summary: 'لم يكتمل الدفع',
  });
  assert.match(text, /966511111111/);
  assert.match(text, /مشكلة في الدفع/);
  assert.match(text, /لم يكتمل الدفع/);
});
