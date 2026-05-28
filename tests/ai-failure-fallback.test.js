'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// We stub the modules ai-worker depends on BEFORE requiring it, so we can
// drive its behavior without touching Redis or Postgres. The goal of this
// suite is to verify that when the AI generation fails on the final attempt
// (attemptsMade >= 2), the worker enqueues an `ai_failure_fallback` outbound
// message, marks itself completed (no throw), and uses a deterministic
// jobKey so a duplicate fallback can't be enqueued by accident.

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

// db client — make resolveConversation throw so processAiReply jumps straight
// to the catch. The fallback path uses payload fields, not the conversation.
stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), {
  isConfigured: () => true,
  query: async () => { throw new Error('simulated db outage'); },
  close: async () => {},
});

// runtime-bot — return a config carrying a custom fallbackMessage so we can
// confirm the worker prefers it over the hard-coded default.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({ fallbackMessage: 'fallback-from-config' }),
});

// platform-features — no auto-reply.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
});

// quota — never block.
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }),
});

// notify mailer — no SMTP configured, returns null.
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), {
  createMailer: () => null,
});

// Capture outgoing enqueues.
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

// AI client — never invoked because resolveConversation throws first, but
// stub anyway so the require doesn't try to wire up an OpenAI client.
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply() { return 'unused'; }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob({ attemptsMade }) {
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

test('on the final attempt the worker enqueues the fallback and returns (no throw)', async () => {
  outgoingCalls.length = 0;
  const result = await processAiReply(makeJob({ attemptsMade: 2 }));
  assert.equal(result.fallbackSent, true);
  assert.equal(result.source, 'ai_failure_fallback');
  const fallbackEnqueues = outgoingCalls.filter(
    c => c.payload.source === 'ai_failure_fallback',
  );
  assert.equal(fallbackEnqueues.length, 1, 'exactly one fallback enqueued');
  assert.equal(fallbackEnqueues[0].payload.reply, 'fallback-from-config');
  assert.equal(fallbackEnqueues[0].options.jobKey, 'fallback:msg-1');
});

test('on an earlier attempt the worker re-throws so BullMQ retries', async () => {
  outgoingCalls.length = 0;
  await assert.rejects(
    () => processAiReply(makeJob({ attemptsMade: 0 })),
    /simulated db outage/,
  );
  const fallbackEnqueues = outgoingCalls.filter(
    c => c.payload.source === 'ai_failure_fallback',
  );
  assert.equal(fallbackEnqueues.length, 0, 'no fallback before the final attempt');
});

test('fallback jobKey is deterministic so a duplicate enqueue is a no-op upstream', async () => {
  outgoingCalls.length = 0;
  await processAiReply(makeJob({ attemptsMade: 2 }));
  await processAiReply(makeJob({ attemptsMade: 2 }));
  const keys = outgoingCalls
    .filter(c => c.payload.source === 'ai_failure_fallback')
    .map(c => c.options.jobKey);
  // Both enqueues use the same jobKey (based on messageId). The real queue
  // would dedup on the unique (queue_name, job_key) index — we just assert
  // the worker hands the same key to enqueueOutgoingWhatsapp both times.
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], 'fallback:msg-1');
});
