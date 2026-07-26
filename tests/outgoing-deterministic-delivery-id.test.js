'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeterministicDeliveryId,
  sendWhatsappReply,
} = require('../src/workers/outgoing-whatsapp-worker');

test('same scoped reply retry uses the same WhatsApp message id', async () => {
  const sends = [];
  const bot = {
    client: {
      sendMessage: async (sender, reply, options) => {
        sends.push({ sender, reply, options });
        return { key: { id: options.messageId } };
      },
    },
  };
  const input = {
    sender: 'customer-1',
    reply: 'hello',
    replyMessageId: 'reply-1',
    userId: 'tenant-1',
    conversationId: 'conversation-1',
  };

  await sendWhatsappReply(bot, input);
  await sendWhatsappReply(bot, input);

  assert.equal(sends.length, 2);
  assert.equal(sends[0].options.messageId, sends[1].options.messageId);
  assert.equal(
    sends[0].options.messageId,
    buildDeterministicDeliveryId(input),
  );
});

test('delivery ids change with every scope component', () => {
  const base = {
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1',
    replyMessageId: 'reply-1',
  };
  const original = buildDeterministicDeliveryId(base);
  for (const changed of [
    { userId: 'tenant-2' },
    { conversationId: 'conversation-2' },
    { sender: 'customer-2' },
    { replyMessageId: 'reply-2' },
  ]) {
    assert.notEqual(buildDeterministicDeliveryId({ ...base, ...changed }), original);
  }
});
