'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAiReplyQueueOptions } = require('../src/queues/message-queue');
const {
  buildCombinedInboundText,
  enrichInboundMessagesWithMedia,
  loadPendingInboundMessages,
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

test('loadPendingInboundMessages loads queued inbound messages since last assistant reply', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.match(sql, /last_assistant/);
      assert.match(sql, /m\.created_at >= NOW\(\) - \(\$4 \* interval '1 millisecond'\)/);
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

  assert.deepEqual(calls[0].params, ['conv-1', 'user-1', 20, 600000]);
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
