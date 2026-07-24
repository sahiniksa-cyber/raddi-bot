'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { markInboundMessageFailed } = require('../src/workers/ai-worker');

test('markInboundMessageFailed stores ai failure details on inbound message', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await markInboundMessageFailed({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    error: new Error('missing api key'),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE messages/);
  assert.equal(calls[0].params[0], 'msg-1');
  assert.equal(calls[0].params[1], 'ai_failed');
  const payload = JSON.parse(calls[0].params[2]);
  assert.match(payload.aiFailedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.error, 'missing api key');
});
