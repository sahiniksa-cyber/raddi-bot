'use strict';

// The @lid outgoing branch (the majority of privacy-masked customers) must honor
// the atomic send-time stale guard exactly like the main path: if a newer
// customer message arrived (higher inbound_seq) before the reply is sent, the
// @lid reply is canceled, not delivered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.SEND_STALE_GUARD_ENABLED = 'true';

const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath, filename: dbModulePath + '.js', loaded: true,
  exports: {
    isConfigured: () => true,
    query: async (sql) => {
      // The atomic stale-claim UPDATE claims 0 rows → a newer inbound exists → stale.
      if (/UPDATE messages\s+SET status = 'sending'/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // Outgoing scope validation must find the persisted reply row.
      if (/FROM messages m\s+JOIN conversations c/i.test(sql)) {
        return { rows: [{ id: 'msg-1', content: 'مرحبا', status: 'queued_for_send', whatsapp_message_id: null }], rowCount: 1 };
      }
      // No owner pause, reply not already sent, etc.
      return { rows: [], rowCount: 0 };
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
    id: 'job-lid-stale', data: {
      userId: 'user-1', sender: '278571713060916@lid', reply: 'مرحبا', replyMessageId: 'msg-1',
      conversationId: 'conv-1', source: 'ai_reply', generatedAgainstSeq: 5, ...data,
    }, timestamp: Date.now(), attemptsMade: 0, opts: { attempts: 3 },
  };
}

test('@lid outgoing is CANCELED as stale when a newer inbound arrived (0 rows claimed)', async () => {
  let sendAttempted = false;
  const getUserBot = async () => ({
    sessionDesiredState: 'running',
    client: { sendMessage: async () => { sendAttempted = true; return { key: { id: 'x' } }; } },
  });

  const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });

  assert.equal(result.skipped, true, 'must skip');
  assert.equal(result.reason, 'stale_new_inbound', 'must be canceled as stale');
  assert.equal(result.lid, true, 'lid path');
  assert.equal(sendAttempted, false, 'must NOT send a stale reply to the @lid customer');
});

test('source: handleLidOutgoing runs claimSendOrStale BEFORE the @lid send', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  const fnIdx = src.indexOf('async function handleLidOutgoing(');
  assert.ok(fnIdx > 0, 'handleLidOutgoing exists');
  const guardIdx = src.indexOf('claimSendOrStale', fnIdx);
  const sendIdx = src.indexOf('bot.client.sendMessage(sender', fnIdx);
  assert.ok(guardIdx > fnIdx, 'stale guard exists inside handleLidOutgoing');
  assert.ok(sendIdx > guardIdx, 'stale guard runs BEFORE the @lid send');
});
