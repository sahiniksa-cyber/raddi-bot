'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

const outgoing = [];
const sqlCalls = [];
let aiConstructed = false;

const dbMock = {
  isConfigured: () => true,
  async query(sql, params) {
    const text = String(sql);
    sqlCalls.push({ text, params });
    if (text.includes('FROM conversations') && text.includes('WHERE id = $1 AND user_id = $2')) {
      return {
        rows: [{
          id: 'conv-1',
          sender: '966500000000@s.whatsapp.net',
          phone_number: '966500000000',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('escalated_until > NOW()')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('last_assistant') && text.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return {
        rows: [{
          id: '00000000-0000-4000-8000-000000000001',
          content: 'كم السعر؟',
          provider_message_id: 'wa-in-1',
          raw_payload: { timestamp: Math.floor(Date.now() / 1000) },
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM messages') && text.includes("direction = 'inbound'")) {
      return { rows: [{ content: 'كم السعر؟' }], rowCount: 1 };
    }
    if (text.includes("SET status = 'auto_reply_disabled'")) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001' }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({
    storeName: '',
    storeDescription: '',
    workingHours: '',
    botInstructions: '',
    products: [],
    autoReplyKeywords: {},
    learningEnabled: true,
    autoReplyEnabled: false,
  }),
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), {
  loadActiveLearnedReplies: async () => [],
});
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: {
    incomingMessages: 'incoming-messages',
    aiReplies: 'ai-replies',
    outgoingWhatsapp: 'outgoing-whatsapp',
  },
  enqueueOutgoingWhatsapp: async (...args) => {
    outgoing.push(args);
  },
  enqueueAiReply: async () => {},
  resolveDebounceMs: () => 1000,
});
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class ForbiddenAIClient {
  constructor() {
    aiConstructed = true;
    throw new Error('AI must not be constructed while auto-reply is disabled');
  }
});

const { processAiReply } = require('../src/workers/ai-worker');

test('disabled auto-reply retires inbound and sends nothing while WhatsApp stays independent', async () => {
  const result = await processAiReply({
    id: 'job-empty-knowledge-1',
    data: {
      userId: 'user-1',
      conversationId: 'conv-1',
      messageId: '00000000-0000-4000-8000-000000000001',
      sender: '966500000000@s.whatsapp.net',
      providerMessageId: 'wa-in-1',
    },
    attemptsMade: 0,
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: 'auto_reply_disabled',
    retired: 1,
  });
  assert.equal(aiConstructed, false);
  assert.equal(outgoing.length, 0);
  assert.ok(sqlCalls.some(call =>
    call.text.includes("status = 'auto_reply_disabled'")));
  assert.ok(sqlCalls.some(call =>
    call.text.includes('UPDATE jobs')
    && call.params.includes('skipped_auto_reply_disabled')));
});
