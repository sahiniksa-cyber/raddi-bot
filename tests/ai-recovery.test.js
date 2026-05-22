'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recoverQueuedAiReplyJobs } = require('../src/workers/ai-recovery');

test('recoverQueuedAiReplyJobs reenqueues queued inbound messages by conversation', async () => {
  const enqueued = [];
  const database = {
    isConfigured: () => true,
    query: async () => ({
      rows: [{
        user_id: 'user-1',
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        sender: '966501234567@s.whatsapp.net',
        content: 'ابي السعر',
        provider_message_id: 'wa-1',
      }],
    }),
  };

  const result = await recoverQueuedAiReplyJobs({
    database,
    enqueue: async (payload, options) => enqueued.push({ payload, options }),
  });

  assert.equal(result.recovered, 1);
  assert.equal(enqueued[0].payload.conversationId, 'conv-1');
  assert.equal(enqueued[0].options.jobKey, 'conversation-conv-1');
  assert.doesNotMatch(enqueued[0].options.jobKey, /:/);
});

test('recoverQueuedAiReplyJobs ignores queued messages older than the safe recovery window', async () => {
  const enqueued = [];
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => {
      assert.match(sql, /created_at >= NOW\(\) - \(\$2 \* interval '1 millisecond'\)/);
      assert.deepEqual(params, [100, 600000]);
      return { rows: [] };
    },
  };

  const result = await recoverQueuedAiReplyJobs({
    database,
    enqueue: async (payload, options) => enqueued.push({ payload, options }),
    maxAgeMs: 600000,
  });

  assert.equal(result.recovered, 0);
  assert.equal(enqueued.length, 0);
});

test('recoverQueuedAiReplyJobs retries an existing failed BullMQ AI job', async () => {
  let retried = 0;
  const database = {
    isConfigured: () => true,
    query: async () => ({
      rows: [{
        user_id: 'user-1',
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        sender: '966501234567@s.whatsapp.net',
        content: 'السلام عليكم',
        provider_message_id: 'wa-1',
      }],
    }),
  };
  const aiQueue = {
    getJob: async (jobKey) => {
      assert.equal(jobKey, 'conversation-conv-1');
      return {
        getState: async () => 'failed',
        retry: async (state) => {
          assert.equal(state, 'failed');
          retried++;
        },
      };
    },
  };

  const result = await recoverQueuedAiReplyJobs({
    database,
    aiQueue,
    enqueue: async () => {
      throw new Error('Job conversation-conv-1 already exists');
    },
  });

  assert.equal(result.recovered, 1);
  assert.equal(retried, 1);
});
