'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConversationTitle,
  classifyConversation,
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

test('classifyConversation labels recent chats ongoing and older ones finished', () => {
  const now = Date.parse('2026-05-21T20:00:00.000Z');
  assert.equal(classifyConversation('2026-05-21T19:50:00.000Z', { now }), 'ongoing');
  assert.equal(classifyConversation('2026-05-21T19:00:00.000Z', { now }), 'finished');
});

test('conversations controller returns counts, status, and transcripts', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) {
        return { rows: [{ total: 3, ongoing: 1, finished: 2 }] };
      }
      if (/FROM conversations/.test(sql)) {
        return {
          rows: [
            {
              id: 'conv-1',
              sender: '966501234567@s.whatsapp.net',
              last_message_at: new Date().toISOString(),
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
  const res = { body: null, json(body) { this.body = body; } };

  await controller.list({ session: { userId: 'user-1' }, query: {} }, res);

  assert.equal(calls.length, 3);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 3);
  assert.deepEqual(res.body.counts, { all: 3, ongoing: 1, finished: 2 });
  assert.equal(res.body.status, 'all');
  assert.equal(res.body.conversations[0].phone, '+966501234567');
  assert.equal(res.body.conversations[0].title, 'ابي السعر');
  assert.equal(res.body.conversations[0].status, 'ongoing');
  assert.deepEqual(res.body.conversations[0].messages.map(m => m.speaker), ['العميل', 'AI']);
});

test('conversations controller filters by status and parameterizes the cutoff', async () => {
  const listCalls = [];
  const database = {
    query: async (sql, params) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 5, ongoing: 2, finished: 3 }] };
      if (/FROM conversations c/.test(sql)) { listCalls.push({ sql, params }); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const controller = createConversationsController({ database });
  const res = { body: null, json(body) { this.body = body; } };

  await controller.list({ session: { userId: 'user-1' }, query: { status: 'finished' } }, res);

  assert.equal(res.body.status, 'finished');
  assert.match(listCalls[0].sql, /c\.last_message_at < \$2/);
});
