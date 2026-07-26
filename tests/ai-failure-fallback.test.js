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

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), {
  isConfigured: () => true,
  query: async () => { throw new Error('simulated db outage'); },
  close: async () => {},
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({
    fallbackMessage: 'UNAUTHORIZED-FALLBACK-PROMISE',
  }),
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  combineCannedAndAi: (left, right) => `${left}\n${right}`,
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }),
});

const outgoingCalls = [];
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: {
    incomingMessages: 'incoming-messages',
    aiReplies: 'ai-replies',
    outgoingWhatsapp: 'outgoing-whatsapp',
  },
  enqueueOutgoingWhatsapp: async (payload, options) => {
    outgoingCalls.push({ payload, options });
    return { id: `out-${outgoingCalls.length}` };
  },
});
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  async getReply() { return 'unused'; }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob(attemptsMade) {
  return {
    id: `job-${attemptsMade}`,
    data: {
      userId: 'user-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      sender: '966500000000@s.whatsapp.net',
      providerMessageId: 'provider-1',
    },
    attemptsMade,
  };
}

test('database failure remains fail-closed even after retries are exhausted', async () => {
  outgoingCalls.length = 0;
  await assert.rejects(() => processAiReply(makeJob(2)), /simulated db outage/);
  assert.equal(outgoingCalls.length, 0);
});

test('an untyped legacy fallback is never interpreted or sent', async () => {
  outgoingCalls.length = 0;
  await assert.rejects(() => processAiReply(makeJob(2)));
  assert.equal(
    outgoingCalls.some(call => String(call.payload.reply).includes('UNAUTHORIZED')),
    false,
  );
});

test('retries cannot turn a failed dependency into duplicate generic replies', async () => {
  outgoingCalls.length = 0;
  await assert.rejects(() => processAiReply(makeJob(2)));
  await assert.rejects(() => processAiReply(makeJob(2)));
  assert.equal(outgoingCalls.length, 0);
});
