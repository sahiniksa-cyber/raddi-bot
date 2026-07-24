'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reviewOutgoingReplyBeforeSend } = require('../src/services/ai/pre-send-review');

test('20 concurrent customers never receive another conversation secret in the reviewed reply', async () => {
  const customers = Array.from({ length: 20 }, (_, index) => ({
    userId: `tenant-${index % 4}`,
    conversationId: `conversation-${index}`,
    replyMessageId: `reply-${index}`,
    customerId: `customer-${index}@s.whatsapp.net`,
    secret: `SECRET_CUSTOMER_${index}_${'x'.repeat(index + 1)}`,
  }));
  const byReply = new Map(customers.map(customer => [customer.replyMessageId, customer]));
  const byScope = new Map(customers.map(customer => [
    `${customer.userId}|${customer.conversationId}|${customer.customerId}`,
    customer,
  ]));

  const database = {
    isConfigured: () => true,
    query: async (sql, params) => {
      await new Promise(resolve => setImmediate(resolve));
      if (/SELECT id, content, raw_payload/.test(sql)) {
        const customer = byReply.get(params[1]);
        if (
          !customer
          || customer.userId !== params[0]
          || customer.conversationId !== params[2]
          || customer.customerId !== params[4]
        ) return { rows: [] };
        return {
          rows: [{
            id: customer.replyMessageId,
            content: `answer for ${customer.secret}`,
            raw_payload: {},
          }],
        };
      }
      if (/SELECT role, direction, content/.test(sql)) {
        const customer = byScope.get(`${params[0]}|${params[1]}|${params[4]}`);
        if (!customer) return { rows: [] };
        return {
          rows: [{
            id: `inbound-${customer.conversationId}`,
            role: 'user',
            direction: 'inbound',
            content: `my secret is ${customer.secret}`,
            status: 'answered_by_ai',
            raw_payload: {},
            created_at: '2026-07-24T12:00:00.000Z',
          }],
        };
      }
      if (/UPDATE messages/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const results = await Promise.all(customers.map(customer => reviewOutgoingReplyBeforeSend({
    database,
    bot: {
      reviewReplyBeforeSend: async ({ draft, history, customerText }) => {
        await new Promise(resolve => setImmediate(resolve));
        return {
          reply: `reviewed ${JSON.stringify({ draft, history, customerText })}`,
          suppressed: false,
          audit: { decision: 'pass', confidence: 1 },
        };
      },
    },
    userId: customer.userId,
    conversationId: customer.conversationId,
    replyMessageId: customer.replyMessageId,
    draft: 'stale payload',
    payload: {
      source: 'ai_reply',
      preSendReviewRequired: true,
      channelId: 'whatsapp',
      sender: customer.customerId,
      customerId: customer.customerId,
    },
  })));

  for (let index = 0; index < results.length; index++) {
    const serialized = JSON.stringify(results[index]);
    assert.match(serialized, new RegExp(customers[index].secret));
    for (let other = 0; other < customers.length; other++) {
      if (other === index) continue;
      assert.doesNotMatch(serialized, new RegExp(customers[other].secret));
    }
  }
});
