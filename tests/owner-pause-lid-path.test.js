'use strict';

// Regression: the @lid outgoing branch (the vast majority of customers on
// privacy-masked numbers) used to SKIP the owner-pause check entirely, so the
// bot replied even after the owner stepped in. The @lid path must honor
// owner-pause exactly like the main path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Stub db: the conversations escalated_until query returns a FUTURE time so the
// owner-pause check trips; every other query is a no-op.
const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath, filename: dbModulePath + '.js', loaded: true,
  exports: {
    isConfigured: () => true,
    query: async (sql) => {
      if (/escalated_until\s+FROM\s+conversations/i.test(sql) || /SELECT\s+escalated_until/i.test(sql)) {
        return { rows: [{ escalated_until: future }] };
      }
      return { rows: [] };
    },
    getDatabaseUrl: () => 'stub', close: async () => {},
  },
};
const quotaModulePath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
require.cache[require.resolve(quotaModulePath)] = {
  id: quotaModulePath, filename: quotaModulePath + '.js', loaded: true,
  exports: {
    checkMessageQuota: async () => ({ canReply: true, remaining: 100 }),
    decrementMessageQuota: async () => ({ success: true, remaining: 99 }),
  },
};

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');

function makeJob(data = {}) {
  return {
    id: 'job-lid-pause', data: {
      userId: 'user-1', sender: '278571713060916@lid', reply: 'مرحبا', replyMessageId: 'msg-1', ...data,
    }, timestamp: Date.now(), attemptsMade: 0, opts: { attempts: 3 },
  };
}

test('@lid outgoing is CANCELED when the owner has replied (owner-pause honored)', async () => {
  let sendAttempted = false;
  // getUserBot returns a non-stopped bot whose send would succeed — but we must
  // cancel BEFORE reaching the send because the owner is paused.
  const getUserBot = async () => ({
    sessionDesiredState: 'running',
    client: { sendMessage: async () => { sendAttempted = true; return { key: { id: 'x' } }; } },
  });

  const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });

  assert.equal(result.skipped, true, 'must skip');
  assert.equal(result.reason, 'owner_paused', 'must be canceled for owner_paused');
  assert.equal(result.lid, true, 'lid path');
  assert.equal(sendAttempted, false, 'must NOT send to the customer after owner replied');
});

test('source: handleLidOutgoing checks isConversationOwnerPaused before sending', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  const fnIdx = src.indexOf('async function handleLidOutgoing(');
  assert.ok(fnIdx > 0, 'handleLidOutgoing exists');
  const checkIdx = src.indexOf('isConversationOwnerPaused', fnIdx);
  const sendIdx = src.indexOf('bot.client.sendMessage(sender, reply)', fnIdx);
  assert.ok(checkIdx > fnIdx, 'owner-pause check exists inside handleLidOutgoing');
  assert.ok(sendIdx > checkIdx, 'owner-pause check runs BEFORE the @lid send');
});
