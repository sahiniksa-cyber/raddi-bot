'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enqueueFollowupIfPending,
  sendInstantAutoReply,
} = require('../src/workers/ai-worker');
const { ensureReusableQueueJobId } = require('../src/queues/message-queue');

// ── FIX 1: self-healing follow-up enqueue ─────────────────────────────

test('FIX 1: enqueueFollowupIfPending enqueues a debounced job when pending inbound messages exist', async () => {
  const database = {
    isConfigured: () => true,
    // loadPendingInboundMessages runs a single SELECT; return one pending row.
    query: async () => ({
      rows: [{ id: 'msg-1', content: 'سؤال جديد', provider_message_id: 'wa-1', raw_payload: {} }],
    }),
  };

  const enqueueCalls = [];
  const enqueue = async (payload, options) => { enqueueCalls.push({ payload, options }); };

  const result = await enqueueFollowupIfPending({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    enqueue,
    debounceMs: 9000,
  });

  assert.equal(result.enqueued, true);
  assert.equal(result.pending, 1);
  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0].payload, {
    userId: 'user-1',
    conversationId: 'conv-1',
    source: 'followup',
  });
  assert.equal(enqueueCalls[0].options.jobKey, 'conversation-conv-1');
  assert.equal(enqueueCalls[0].options.delay, 9000);
});

test('FIX 1: enqueueFollowupIfPending does NOT enqueue when no pending messages (no infinite loop)', async () => {
  const database = {
    isConfigured: () => true,
    query: async () => ({ rows: [] }), // all messages already answered_by_ai
  };

  const enqueueCalls = [];
  const enqueue = async (payload, options) => { enqueueCalls.push({ payload, options }); };

  const result = await enqueueFollowupIfPending({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    enqueue,
  });

  assert.equal(result.enqueued, false);
  assert.equal(result.pending, 0);
  assert.equal(enqueueCalls.length, 0);
});

test('FIX 1: enqueueFollowupIfPending no-ops without userId/conversationId', async () => {
  let queried = false;
  const database = { isConfigured: () => true, query: async () => { queried = true; return { rows: [] }; } };
  const enqueue = async () => { throw new Error('should not enqueue'); };

  const r1 = await enqueueFollowupIfPending({ database, conversationId: 'c', enqueue });
  const r2 = await enqueueFollowupIfPending({ database, userId: 'u', enqueue });

  assert.equal(r1.enqueued, false);
  assert.equal(r2.enqueued, false);
  assert.equal(queried, false, 'must not query the DB when ids are missing');
});

// ── FIX 2: instant auto-reply branch marks inbound messages answered ───

test('FIX 2: sendInstantAutoReply marks inbound messages answered before returning', async () => {
  const markedAnswered = [];
  const enqueued = [];

  const result = await sendInstantAutoReply({
    job: { id: 'job-1', attemptsMade: 0 },
    payload: { messageId: 'msg-1', providerMessageId: 'wa-1' },
    conversation: { id: 'conv-1', sender: '9665xxxx' },
    userId: 'user-1',
    instantReply: 'أهلاً وسهلاً 🌷',
    enrichedMessages: [{ id: 'msg-1' }, { id: 'msg-2' }],
    store: async () => 'reply-msg-1',
    enqueueOutgoing: async (payload) => { enqueued.push(payload); },
    markAnswered: async ({ messageIds }) => { markedAnswered.push(...messageIds); },
    setJobStatus: async () => {},
  });

  assert.deepEqual(markedAnswered, ['msg-1', 'msg-2'], 'all batched inbound messages must be marked answered');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].source, 'auto_reply_keyword');
  assert.equal(enqueued[0].preSendReviewRequired, true, 'instant replies must pass the final send-boundary review');
  assert.equal(result.replyMessageId, 'reply-msg-1');
  assert.equal(result.source, 'auto_reply_keyword');
});

// ── FIX 4: debounce timer reset via changeDelay on delayed jobs ────────

test('FIX 4: ensureReusableQueueJobId resets the delay on a delayed job', async () => {
  const changeDelayCalls = [];
  let removed = false;
  const queue = {
    getJob: async () => ({
      getState: async () => 'delayed',
      changeDelay: async (ms) => { changeDelayCalls.push(ms); },
      remove: async () => { removed = true; },
    }),
  };

  const result = await ensureReusableQueueJobId(queue, 'conversation-conv-1', 9000);

  assert.deepEqual(changeDelayCalls, [9000], 'changeDelay should restart the debounce timer from the latest message');
  assert.equal(removed, false, 'a delayed job should not be removed');
  assert.equal(result.delayChanged, true);
});

test('FIX 4: ensureReusableQueueJobId does NOT call changeDelay on an active job', async () => {
  const changeDelayCalls = [];
  const queue = {
    getJob: async () => ({
      getState: async () => 'active',
      processedOn: Date.now(), // fresh — not stale, so not removed
      changeDelay: async (ms) => { changeDelayCalls.push(ms); },
      remove: async () => {},
    }),
  };

  const result = await ensureReusableQueueJobId(queue, 'conversation-conv-1', 9000);

  assert.equal(changeDelayCalls.length, 0, 'active jobs must not have their delay reset');
  assert.equal(result.removed, false);
});

test('FIX 4: ensureReusableQueueJobId does NOT call changeDelay when desired delay is 0', async () => {
  const changeDelayCalls = [];
  const queue = {
    getJob: async () => ({
      getState: async () => 'delayed',
      changeDelay: async (ms) => { changeDelayCalls.push(ms); },
      remove: async () => {},
    }),
  };

  await ensureReusableQueueJobId(queue, 'conversation-conv-1', 0);

  assert.equal(changeDelayCalls.length, 0, 'a 0ms delay (immediate) should not reset the timer');
});

test('FIX 4: ensureReusableQueueJobId swallows changeDelay errors and falls through', async () => {
  const queue = {
    getJob: async () => ({
      getState: async () => 'delayed',
      changeDelay: async () => { throw new Error('job moved states'); },
      remove: async () => {},
    }),
  };

  const result = await ensureReusableQueueJobId(queue, 'conversation-conv-1', 9000);

  assert.equal(result.removed, false);
  assert.match(result.error, /job moved states/);
});

test('FIX 4: ensureReusableQueueJobId still removes completed jobs (behavior preserved)', async () => {
  let removed = 0;
  const queue = {
    getJob: async () => ({
      getState: async () => 'completed',
      remove: async () => { removed++; },
    }),
  };

  const result = await ensureReusableQueueJobId(queue, 'conversation-conv-1', 9000);

  assert.equal(result.removed, true);
  assert.equal(removed, 1);
});
