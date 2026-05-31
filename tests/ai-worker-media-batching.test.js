'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAiReplyQueueOptions, ensureReusableQueueJobId } = require('../src/queues/message-queue');
const {
  buildCombinedInboundText,
  enrichInboundMessagesWithMedia,
  loadPendingInboundMessages,
  waitForDatabaseReady,
} = require('../src/workers/ai-worker');

test('buildAiReplyQueueOptions debounces AI jobs per conversation', () => {
  const options = buildAiReplyQueueOptions({
    conversationId: 'conv-1',
    messageId: 'msg-1',
  });

  assert.equal(options.jobId, 'conversation-conv-1');
  assert.equal(options.jobKey, 'conversation-conv-1');
  assert.doesNotMatch(options.jobId, /:/);
  assert.equal(options.delay > 0, true);
});

test('ensureReusableQueueJobId removes completed debounce jobs before enqueueing again', async () => {
  let removed = 0;
  const queue = {
    getJob: async (jobId) => {
      assert.equal(jobId, 'conversation-conv-1');
      return {
        getState: async () => 'completed',
        remove: async () => { removed++; },
      };
    },
  };

  const result = await ensureReusableQueueJobId(queue, 'conversation-conv-1');

  assert.equal(result.removed, true);
  assert.equal(removed, 1);
});

test('waitForDatabaseReady retries transient PostgreSQL startup errors', async () => {
  let attempts = 0;
  const database = {
    ping: async () => {
      attempts++;
      if (attempts === 1) throw new Error('the database system is not yet accepting connections');
      return { ok: true };
    },
  };

  const result = await waitForDatabaseReady({
    database,
    timeoutMs: 100,
    intervalMs: 1,
    logger: { warn: () => {}, info: () => {} },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
});

test('loadPendingInboundMessages loads queued inbound messages since last assistant reply', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.match(sql, /last_assistant/);
      assert.match(sql, /m\.created_at >= NOW\(\) - \(\$4 \* interval '1 millisecond'\)/);
      // The fragile provider-timestamp CASE filter was removed (it silently
      // dropped rows whose raw_payload.timestamp was missing/non-numeric).
      assert.doesNotMatch(sql, /raw_payload->>'timestamp'/);
      return {
        rows: [
          { id: 'msg-1', content: 'السلام عليكم', provider_message_id: 'wa-1', raw_payload: {} },
          { id: 'msg-2', content: 'كم السعر؟', provider_message_id: 'wa-2', raw_payload: {} },
        ],
      };
    },
  };

  const messages = await loadPendingInboundMessages({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    fallbackMessageId: 'msg-2',
    fallbackText: 'كم السعر؟',
  });

  assert.equal(calls[0].params.length, 4);
  assert.deepEqual(calls[0].params, ['conv-1', 'user-1', 20, 1800000]);
  assert.deepEqual(messages.map(m => m.id), ['msg-1', 'msg-2']);
});

test('loadPendingInboundMessages does not fall back to stale payload text when no queued rows exist', async () => {
  const database = {
    query: async () => ({ rows: [] }),
  };

  const messages = await loadPendingInboundMessages({
    database,
    userId: 'user-1',
    conversationId: 'conv-1',
    fallbackMessageId: 'old-msg',
    fallbackText: 'رسالة قديمة',
  });

  assert.deepEqual(messages, []);
});

test('buildCombinedInboundText combines rapid customer messages into one prompt', () => {
  const text = buildCombinedInboundText([
    { content: 'السلام عليكم' },
    { content: 'ابي السعر' },
    { content: 'وهل فيه ضمان؟' },
  ]);

  assert.match(text, /رسائل العميل المتتالية/);
  assert.match(text, /1\. السلام عليكم/);
  assert.match(text, /3\. وهل فيه ضمان؟/);
});

test('enrichInboundMessagesWithMedia replaces media placeholders with OpenAI analysis text', async () => {
  const messages = await enrichInboundMessagesWithMedia({
    messages: [{
      id: 'msg-1',
      content: '[صورة من العميل]',
      raw_payload: {
        media: {
          kind: 'image',
          mimeType: 'image/jpeg',
          data: Buffer.from('jpg').toString('base64'),
          caption: 'وش المشكلة؟',
        },
      },
    }],
    analyzer: {
      analyze: async () => ({ ok: true, kind: 'image', text: 'الصورة تظهر كرتون تالف' }),
    },
  });

  assert.equal(messages[0].content, '[صورة من العميل: الصورة تظهر كرتون تالف. تعليق العميل: وش المشكلة؟]');
});
