'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEscalationNotification,
  extractEscalationRequest,
  normalizeEscalationPhone,
  normalizeEscalationTarget,
  prepareEscalation,
} = require('../src/workers/escalation-routing');

test('bare 16+ digit targets are treated as group IDs, shorter stay phones', () => {
  assert.equal(normalizeEscalationTarget('120363419087654321'), '120363419087654321@g.us');
  assert.equal(normalizeEscalationTarget('966501234567'), '966501234567@c.us');
});

test('prepareEscalation passes a group NAME through for send-time resolution', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: 'متجر برو خدمة عملاء', when: 'مشكلة' }] };
  const result = prepareEscalation({
    reply: 'أبشر [تحويل:الدعم|مشكلة شحن]',
    config,
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'مشكلة في الشحن',
  });
  assert.ok(result.ownerMessage, 'name target must NOT be dropped');
  assert.equal(result.ownerMessage.sender, 'متجر برو خدمة عملاء');
  assert.equal(result.ownerMessage.needsGroupResolution, true);
  assert.match(result.ownerMessage.reply, /مشكلة شحن/);
});

test('extractEscalationRequest removes private marker from customer reply', () => {
  const result = extractEscalationRequest('ثواني اتأكد لك [تحويل:محمد|العميل يسأل عن مشكلة دفع]');

  assert.deepEqual(result, {
    customerReply: 'ثواني اتأكد لك',
    contactName: 'محمد',
    summary: 'العميل يسأل عن مشكلة دفع',
  });
});

test('buildEscalationNotification applies contact messageTemplate variables', () => {
  const text = buildEscalationNotification({
    contact: {
      name: 'Sarah',
      role: 'shipping',
      messageTemplate: 'To {{contactName}} / {{contactRole}}\nCustomer: {{customerPhone}}\nAsked: {{customerMessage}}\nNeed: {{summary}}',
    },
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'Where is order 123?',
    summary: 'Delayed shipment',
  });

  assert.equal(text, 'To Sarah / shipping\nCustomer: 966500000000\nAsked: Where is order 123?\nNeed: Delayed shipment');
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

test('prepareEscalation does NOT escalate on a contact rule match alone — only an explicit [تحويل:...] marker triggers it', () => {
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
  assert.equal(result.ownerMessage, null, 'rule-only match must not trigger an owner notification');
});

test('prepareEscalation can send owner notifications to a WhatsApp group JID', () => {
  const config = {
    escalationContacts: [
      { name: 'support', phone: '120363123456789012@g.us', role: 'support group', when: 'refund' },
    ],
  };

  const result = prepareEscalation({
    reply: 'I will check that for you [تحويل:support|refund request]',
    config,
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'refund please',
  });

  assert.equal(result.customerReply, 'I will check that for you');
  assert.equal(result.ownerMessage.sender, '120363123456789012@g.us');
  assert.match(result.ownerMessage.reply, /refund/);
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

test('buildEscalationNotification prefers customerPhoneNumber over lid sender', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    customerPhoneNumber: '966512345678',
    inboundText: 'مشكلة في الطلب',
    summary: 'طلب لم يصل',
  });
  assert.ok(text.includes('+966512345678'), 'must include the real phone, got: ' + text);
  assert.ok(!text.includes('@lid'), 'must NOT include the lid');
});

test('buildEscalationNotification masks @lid sender to "عميل ····XXXX" when customerPhoneNumber is missing', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  assert.ok(text.includes('عميل ····0304'), 'must include masked label, got: ' + text);
  assert.ok(!text.includes('@lid'), 'must NOT include raw lid');
});

test('buildEscalationNotification uses "عميل قديم" when @lid has no digits', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم' },
    customerSender: '@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  assert.ok(text.includes('عميل قديم'));
  assert.ok(!text.includes('@lid'));
});

test('prepareEscalation threads customerPhoneNumber into the owner notification', () => {
  const config = {
    escalationContacts: [{ name: 'علي', role: 'دعم', phone: '966500000000' }],
  };
  const result = prepareEscalation({
    reply: 'ثواني اتأكد لك [تحويل:علي|مشكلة دفع]',
    config,
    customerSender: '276282495500304@lid',
    customerPhoneNumber: '966512345678',
    inboundText: 'ما اقدر ادفع',
  });
  assert.ok(result.ownerMessage, 'escalation must produce an owner message');
  assert.ok(result.ownerMessage.reply.includes('+966512345678'));
  assert.ok(!result.ownerMessage.reply.includes('@lid'));
});
