'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { routePreSendEscalation } = require('../src/workers/outgoing-whatsapp-worker');

const config = {
  escalationContacts: [{
    name: 'الموظف',
    role: 'خدمة العملاء',
    phone: '966500000000',
  }],
};

test('handoff job key is unique per inbound message when no persisted reply row exists', async () => {
  const enqueued = [];
  const common = {
    finalReply: 'تم، بخلي الموظف يتابع معك. [تحويل:الموظف|مشكلة مالية]',
    config,
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    inboundText: 'انخصم المبلغ',
    enqueueOutgoing: async (payload, options) => enqueued.push({ payload, options }),
  };

  await routePreSendEscalation({ ...common, handoffKey: 'inbound-1' });
  await routePreSendEscalation({ ...common, handoffKey: 'inbound-2' });

  assert.notEqual(enqueued[0].options.jobKey, enqueued[1].options.jobKey);
});
