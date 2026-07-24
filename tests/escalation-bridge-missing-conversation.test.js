'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { relayResolutionToCustomer } = require('../src/services/escalation/escalation-bridge');

test('bridge resolves a scoped conversation before inserting when an old thread has no conversation id', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO conversations/.test(sql)) return { rows: [{ id: 'resolved-conversation' }] };
      if (/INSERT INTO messages/.test(sql)) return { rows: [{ id: 'reply-resolved' }] };
      return { rows: [] };
    },
  };
  const enqueued = [];

  const result = await relayResolutionToCustomer({
    database,
    enqueue: async payload => enqueued.push(payload),
    rephrase: async ({ teamAnswer }) => teamAnswer,
    userId: 'tenant-1',
    thread: {
      id: 'thread-old',
      customer_sender: '9665@s.whatsapp.net',
      target_jid: '120363@g.us',
      conversation_id: null,
    },
    text: 'تم الحل',
  });

  assert.equal(result.relayed, true);
  const insert = calls.find(call => /INSERT INTO messages/.test(call.sql));
  assert.equal(insert.params[0], 'resolved-conversation');
  assert.equal(enqueued[0].conversationId, 'resolved-conversation');
  assert.equal(enqueued[0].customerId, '9665@s.whatsapp.net');
});
