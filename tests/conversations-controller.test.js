'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConversationTitle,
  cleanCustomerPhone,
  createConversationsController,
} = require('../src/controllers/conversations.controller');

test('cleanCustomerPhone extracts readable WhatsApp phone numbers', () => {
  assert.equal(cleanCustomerPhone('966501234567@s.whatsapp.net'), '+966501234567');
  assert.equal(cleanCustomerPhone('966501234567@c.us'), '+966501234567');
  assert.equal(cleanCustomerPhone('278571713060916@lid'), '278571713060916@lid');
});

test('buildConversationTitle uses the first customer inquiry', () => {
  assert.equal(buildConversationTitle('[صورة من العميل: كرتون تالف]'), 'صورة من العميل: كرتون تالف');
  assert.equal(buildConversationTitle('كم سعر الاشتراك الشهري؟ وهل فيه ضمان؟'), 'كم سعر الاشتراك الشهري؟ وهل فيه ضمان؟');
});

test('conversations controller returns customer count and transcripts', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM conversations/.test(sql)) {
        return {
          rows: [
            {
              id: 'conv-1',
              sender: '966501234567@s.whatsapp.net',
              last_message_at: '2026-05-21T20:00:00.000Z',
              first_inquiry: 'ابي السعر',
            },
          ],
        };
      }
      return {
        rows: [
          { conversation_id: 'conv-1', role: 'user', direction: 'inbound', content: 'ابي السعر', created_at: '2026-05-21T20:00:00.000Z' },
          { conversation_id: 'conv-1', role: 'assistant', direction: 'outbound', content: 'السعر 59 ريال', created_at: '2026-05-21T20:00:05.000Z' },
        ],
      };
    },
  };
  const controller = createConversationsController({ database });
  const res = {
    body: null,
    json(body) { this.body = body; },
  };

  await controller.list({ session: { userId: 'user-1' } }, res);

  assert.equal(calls.length, 2);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.conversations[0].phone, '+966501234567');
  assert.equal(res.body.conversations[0].title, 'ابي السعر');
  assert.deepEqual(res.body.conversations[0].messages.map(m => m.speaker), ['العميل', 'AI']);
});
