'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reviewOutgoingReplyBeforeSend } = require('../src/services/ai/pre-send-review');

test('pre-send review fails closed when customer scope does not match a persisted message', async () => {
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      if (/SELECT id, content, raw_payload/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    reviewOutgoingReplyBeforeSend({
      database,
      bot: { reviewReplyBeforeSend: async () => ({ reply: 'must not run' }) },
      payload: {
        source: 'ai_reply',
        preSendReviewRequired: true,
        channelId: 'whatsapp',
        sender: 'wrong-customer@s.whatsapp.net',
        customerId: 'wrong-customer@s.whatsapp.net',
      },
      userId: 'tenant-1',
      conversationId: 'conversation-1',
      replyMessageId: 'reply-1',
      draft: 'stale',
    }),
    /could not find the outbound message/,
  );
});
