'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  insertInboundMessage,
} = require('../src/services/whatsapp/message-ingest.service');

test('a duplicate provider message is returned as existing without resetting its status', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO messages/.test(sql)) return { rows: [] };
      if (/SELECT id FROM messages/.test(sql)) return { rows: [{ id: 'existing-message' }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await insertInboundMessage(client, {
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    text: 'hello',
    providerMessageId: 'wa-message-1',
    rawPayload: {},
  });

  assert.deepEqual(result, { id: 'existing-message', inserted: false });
  assert.match(calls[0].sql, /ON CONFLICT[\s\S]+DO NOTHING/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id, channel_id, provider_message_id\)/);
  assert.doesNotMatch(calls[0].sql, /DO UPDATE[\s\S]+queued_for_ai/);
  assert.match(calls[1].sql, /user_id = \$1/);
  assert.match(calls[1].sql, /provider_message_id = \$2/);
});

test('two concurrent deliveries of the same provider message produce one inserted row', async () => {
  const stored = new Map();
  let sequence = 0;
  const client = {
    query: async (sql, params) => {
      await new Promise(resolve => setImmediate(resolve));
      if (/INSERT INTO messages/.test(sql)) {
        const key = `${params[1]}|${params[4]}`;
        if (stored.has(key)) return { rows: [] };
        const id = `message-${++sequence}`;
        stored.set(key, {
          id,
          conversationId: params[0],
          sender: params[2],
        });
        return { rows: [{ id }] };
      }
      if (/SELECT id FROM messages/.test(sql)) {
        const key = `${params[0]}|${params[1]}`;
        const row = stored.get(key);
        if (!row || row.conversationId !== params[2] || row.sender !== params[3]) return { rows: [] };
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const input = {
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    text: 'same delivery',
    providerMessageId: 'same-wa-id',
    rawPayload: {},
  };

  const results = await Promise.all([
    insertInboundMessage(client, input),
    insertInboundMessage(client, input),
  ]);

  assert.equal(results.filter(result => result.inserted).length, 1);
  assert.equal(results.filter(result => !result.inserted).length, 1);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
});
