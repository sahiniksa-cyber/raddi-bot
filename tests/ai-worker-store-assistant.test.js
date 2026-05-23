'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { storeAssistantMessage } = require('../src/workers/ai-worker');

function makeDatabase() {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO messages')) {
        inserts.push({ sql, params });
        return { rows: [{ id: `msg-${inserts.length}` }] };
      }
      if (sql.includes('UPDATE conversations')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('storeAssistantMessage uses a unique provider_message_id per reply', async () => {
  // Regression: the old code used `ai-worker:${jobId}` directly. Since BullMQ
  // job IDs are scoped to the conversation (conversation-${id}) for debouncing,
  // every reply in the same conversation produced the same provider_message_id,
  // violating the UNIQUE (user_id, provider_message_id) constraint after the
  // first reply.
  const database = makeDatabase();
  const params = {
    userId: 'user-1',
    conversationId: 'conv-1',
    sender: '966500000000@s.whatsapp.net',
    reply: 'hi',
    jobId: 'conversation-conv-1',
    database,
  };

  await storeAssistantMessage(params);
  await storeAssistantMessage(params);
  await storeAssistantMessage(params);

  assert.equal(database.inserts.length, 3);

  const providerIds = database.inserts.map(call => call.params[4]);
  const uniqueIds = new Set(providerIds);
  assert.equal(uniqueIds.size, 3, 'each reply must produce a unique provider_message_id');

  for (const id of providerIds) {
    assert.match(id, /^ai-worker:conversation-conv-1:[0-9a-f-]{36}$/);
  }
});

test('storeAssistantMessage includes the job id in the provider_message_id for traceability', async () => {
  const database = makeDatabase();
  await storeAssistantMessage({
    userId: 'user-1',
    conversationId: 'conv-9',
    sender: 's',
    reply: 'r',
    jobId: 'conversation-conv-9',
    database,
  });

  assert.match(database.inserts[0].params[4], /^ai-worker:conversation-conv-9:/);
});
