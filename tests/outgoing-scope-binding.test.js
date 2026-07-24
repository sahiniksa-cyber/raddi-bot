'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateOutgoingScope,
} = require('../src/workers/outgoing-whatsapp-worker');

test('outgoing scope validation rejects a reply row from another conversation or customer', async () => {
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => {
      assert.match(sql, /m\.user_id = \$2/);
      assert.match(sql, /m\.conversation_id = \$3/);
      assert.match(sql, /m\.sender = \$4/);
      assert.match(sql, /m\.channel_id = \$5/);
      assert.deepEqual(params, [
        'reply-from-other-conversation',
        'tenant-1',
        'conversation-1',
        'customer-1@s.whatsapp.net',
        'whatsapp',
      ]);
      return { rows: [] };
    },
  };

  await assert.rejects(
    validateOutgoingScope({
      database,
      userId: 'tenant-1',
      conversationId: 'conversation-1',
      sender: 'customer-1@s.whatsapp.net',
      replyMessageId: 'reply-from-other-conversation',
    }),
    error => error?.code === 'OUTGOING_SCOPE_MISMATCH',
  );
});

test('outgoing scope validation returns authoritative stored content for the exact tuple', async () => {
  const database = {
    isConfigured: () => true,
    query: async () => ({
      rows: [{
        id: 'reply-1',
        content: 'stored authoritative reply',
        status: 'queued_for_send',
      }],
    }),
  };
  const row = await validateOutgoingScope({
    database,
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    replyMessageId: 'reply-1',
  });
  assert.equal(row.content, 'stored authoritative reply');
});
