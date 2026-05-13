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
    conversationId: 'conv-1',
    config: { memoryMessages: 3 },
    inboundText: 'second question',
  });

  assert.deepEqual(queries[0].params, ['conv-1', 3]);
  assert.deepEqual(history, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
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
    conversationId: 'conv-1',
    config: { memoryMessages: 2 },
    inboundText: 'new question',
  });

  assert.deepEqual(history, [
    { role: 'user', content: 'old question' },
    { role: 'user', content: 'new question' },
  ]);
});
