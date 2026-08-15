'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHistoryForReply, normalizeMemoryLimit } = require('../src/workers/ai-history');

test('normalizeMemoryLimit defaults to 50 and never below 2', () => {
  assert.equal(normalizeMemoryLimit({}), 50);
  assert.equal(normalizeMemoryLimit({ memoryMessages: '' }), 50);
  assert.equal(normalizeMemoryLimit({ memoryMessages: 1 }), 2);
  assert.equal(normalizeMemoryLimit({ memoryMessages: '7' }), 7);
});

test('buildHistoryForReply loads latest messages in chronological order', async () => {
  const queries = [];
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [
          { role: 'user', content: 'second question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'first question' },
        ],
      };
    },
  };

  const history = await buildHistoryForReply({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    customerId: 'customer-1@s.whatsapp.net',
    config: { memoryMessages: 3 },
    inboundText: 'second question',
  });

  assert.deepEqual(queries[0].params, ['conv-1', 3, 'user-1', 'whatsapp', 'customer-1@s.whatsapp.net']);
  // Project to {role,content}; each item also carries an additive `ts` (time context).
  assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  assert.ok('ts' in history[0], 'each history item carries a ts field for the time-context layer');
});

test('buildHistoryForReply appends inbound text when not already last user message', async () => {
  const database = {
    query: async () => ({
      rows: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ],
    }),
  };

  const history = await buildHistoryForReply({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    customerId: 'customer-1@s.whatsapp.net',
    config: { memoryMessages: 2 },
    inboundText: 'new question',
  });

  assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'old question' },
    { role: 'user', content: 'new question' },
  ]);
});

test('buildHistoryForReply starts a fresh session after a long gap and identifies the owner message', async () => {
  const database = {
    query: async () => ({
      rows: [
        {
          role: 'user',
          direction: 'inbound',
          status: 'queued_for_ai',
          content: 'الين بكرة اقدر حاليا اليوم م اقدر اشترك',
          raw_payload: {},
          created_at: '2026-07-18T09:01:00.000Z',
        },
        {
          role: 'assistant',
          direction: 'outbound',
          status: 'sent',
          content: 'السلام عليكم اكدي لنا اذا حابه التفعيل اليوم عشان قبل ما نقفل النظام',
          raw_payload: { source: 'manual_send' },
          created_at: '2026-07-18T09:00:00.000Z',
        },
        {
          role: 'assistant',
          direction: 'outbound',
          status: 'sent_by_human',
          content: 'لا والله عشان الان عليه فعلاً خصم',
          raw_payload: { fromMe: true },
          created_at: '2026-07-17T14:01:00.000Z',
        },
        {
          role: 'user',
          direction: 'inbound',
          status: 'answered_by_human',
          content: 'لو بشترك ادوبي ٨ اشهر هل في خصم؟',
          raw_payload: {},
          created_at: '2026-07-17T14:00:00.000Z',
        },
      ],
    }),
  };

  const history = await buildHistoryForReply({
    database,
    userId: 'user-1',
    conversationId: 'conv-incident',
    customerId: 'customer-1@s.whatsapp.net',
    config: { memoryMessages: 50, historySessionGapMs: 6 * 60 * 60 * 1000 },
    inboundText: 'الين بكرة اقدر حاليا اليوم م اقدر اشترك',
  });

  assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
    {
      role: 'assistant',
      content: 'رسالة من مالك المتجر: السلام عليكم اكدي لنا اذا حابه التفعيل اليوم عشان قبل ما نقفل النظام',
    },
    { role: 'user', content: 'الين بكرة اقدر حاليا اليوم م اقدر اشترك' },
  ]);
  assert.equal(history.some(message => /خصم/.test(message.content)), false);
});
