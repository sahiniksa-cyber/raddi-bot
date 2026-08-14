'use strict';

// When the atomic stale-guard verification hits a DB error, an AI reply must
// NOT be sent (no fail-open). processOutgoingWhatsapp must throw a RETRIABLE
// error so BullMQ retries — for BOTH the normal JID path and the @lid path.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.SEND_STALE_GUARD_ENABLED = 'true';

const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath, filename: dbModulePath + '.js', loaded: true,
  exports: {
    isConfigured: () => true,
    query: async (sql) => {
      const s = String(sql);
      // The atomic stale-claim UPDATE fails (DB error) → must NOT fail-open.
      if (/UPDATE messages\s+SET status = 'sending'/i.test(s)) {
        throw new Error('connection terminated unexpectedly');
      }
      // Outgoing scope validation finds the persisted reply row.
      if (/FROM messages m\s+JOIN conversations c/i.test(s)) {
        return { rows: [{ id: 'msg-1', content: 'مرحبا', status: 'queued_for_send', whatsapp_message_id: null }], rowCount: 1 };
      }
      // isReplyAlreadySent → not sent yet.
      if (/SELECT status, whatsapp_message_id/i.test(s)) {
        return { rows: [{ status: 'queued_for_send', whatsapp_message_id: null }], rowCount: 1 };
      }
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

function makeJob(sender) {
  return {
    id: `job-dberr-${sender}`, data: {
      userId: 'user-1', sender, reply: 'مرحبا', replyMessageId: 'msg-1',
      conversationId: 'conv-1', source: 'ai_reply', generatedAgainstSeq: 5,
    }, timestamp: Date.now(), attemptsMade: 0, opts: { attempts: 3 },
  };
}

for (const sender of ['966500000000@s.whatsapp.net', '278571713060916@lid']) {
  const label = sender.endsWith('@lid') ? '@lid' : 'normal JID';
  test(`${label}: DB error in stale guard → throws retriable, AI reply NOT sent`, async () => {
    let sendAttempted = false;
    const getUserBot = async () => ({
      sessionDesiredState: 'running',
      client: { sendMessage: async () => { sendAttempted = true; return { key: { id: 'x' } }; } },
    });

    await assert.rejects(
      () => processOutgoingWhatsapp(makeJob(sender), { getUserBot }),
      (err) => {
        assert.equal(err.code, 'STALE_GUARD_DB_ERROR', 'must be the retriable stale-guard error');
        assert.equal(err.retriable, true);
        return true;
      },
    );
    assert.equal(sendAttempted, false, 'must NOT send an unverified reply on guard DB error');
  });
}
