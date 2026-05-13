'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEscalationNotification,
  extractEscalationRequest,
  normalizeEscalationPhone,
  prepareEscalation,
} = require('../src/workers/escalation-routing');

test('extractEscalationRequest removes private marker from customer reply', () => {
  const result = extractEscalationRequest('ثواني اتأكد لك [تحويل:محمد|العميل يسأل عن مشكلة دفع]');

  assert.deepEqual(result, {
    customerReply: 'ثواني اتأكد لك',
    contactName: 'محمد',
    summary: 'العميل يسأل عن مشكلة دفع',
  });
});

test('normalizeEscalationPhone converts local Saudi numbers to whatsapp-web jid', () => {
  assert.equal(normalizeEscalationPhone('0562529945'), '966562529945@c.us');
  assert.equal(normalizeEscalationPhone('966562529945'), '966562529945@c.us');
});

test('prepareEscalation targets the requested contact and keeps marker private', () => {
  const config = {
    escalationContacts: [
      { name: 'محمد', phone: '0562529945', role: 'المالك', when: 'المشاكل' },
    ],
  };

  const result = prepareEscalation({
    reply: 'عطني إيميلك وأتواصل معك الحين [تحويل:محمد|اشتراك العميل تعطّل]',
    config,
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'اشتراكي تعطل',
  });

  assert.equal(result.customerReply, 'عطني إيميلك وأتواصل معك الحين');
  assert.equal(result.ownerMessage.sender, '966562529945@c.us');
  assert.match(result.ownerMessage.reply, /اشتراك العميل تعطّل/);
  assert.doesNotMatch(result.ownerMessage.reply, /\[تحويل:/);
});

test('prepareEscalation can route by contact rule when the model omits the marker', () => {
  const config = {
    escalationContacts: [
      { name: 'المتجر', phone: '0593216744', role: 'رقم المتجر', when: 'أي احد يسأل عن اشتراك أدوبي' },
    ],
  };

  const result = prepareEscalation({
    reply: 'كم المدة اللي تحتاجها؟',
    config,
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'ابغى اشتراك أدوبي',
  });

  assert.equal(result.customerReply, 'كم المدة اللي تحتاجها؟');
  assert.equal(result.ownerMessage.sender, '966593216744@c.us');
  assert.match(result.ownerMessage.reply, /قاعدة التحويل/);
});

test('buildEscalationNotification includes customer and problem details', () => {
  const text = buildEscalationNotification({
    contact: { name: 'محمد', role: 'المالك' },
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'احتاج استرجاع',
    summary: 'طلب استرجاع',
  });

  assert.match(text, /طلب استرجاع/);
  assert.match(text, /966500000000/);
  assert.match(text, /احتاج استرجاع/);
});
