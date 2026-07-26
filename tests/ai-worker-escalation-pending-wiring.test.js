'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { policy } = require('./helpers/send-gateway-harness');

// Wiring test: when this conversation has an UNRESOLVED escalation thread,
// processAiReply must fetch that state and pass `escalationPending: true` into
// ai.getReply — that is what makes the system prompt tell the bot the request is
// already registered (stops the "بسجل طلبك" loop). When there is no unresolved
// thread, escalationPending must be falsy and the bot behaves normally.

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let hasPendingThread = false;
const dbMock = {
  isConfigured: () => true,
  async query(sql) {
    const s = String(sql);
    if (s.includes('FROM conversations')
        && s.includes('WHERE id = $1')
        && s.includes('user_id = $2')
        && !s.includes('escalated_until')) {
      return { rows: [{ id: 'conv-1', sender: '966500000000@s.whatsapp.net', phone_number: '966500000000' }], rowCount: 1 };
    }
    if (s.includes('escalated_until') && s.includes('escalated_until > NOW()')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM messages') && s.includes("direction = 'inbound'") && s.includes('WHERE id = $1') && s.includes('user_id = $2')) {
      return { rows: [{ content: 'ايش صار بخصوص المشكلة؟' }], rowCount: 1 };
    }
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return { rows: [{ id: 'inbound-1', content: 'ايش صار بخصوص المشكلة؟', provider_message_id: 'p-in-1', raw_payload: {} }], rowCount: 1 };
    }
    if (s.includes('SELECT role, content, status, direction')) {
      return { rows: [{ role: 'user', content: 'ايش صار بخصوص المشكلة؟', status: 'queued_for_ai', direction: 'inbound' }], rowCount: 1 };
    }
    // getPendingEscalation
    if (s.includes('escalation_threads') && s.includes('resolved_at IS NULL')) {
      return hasPendingThread
        ? { rows: [{ created_at: new Date('2026-06-27T09:00:00Z') }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // findDuplicateRecentReply — none
    if (s.includes('FROM messages') && s.includes("direction = 'outbound'") && s.includes("role = 'assistant'")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) {
      return { rows: [{ id: 'assistant-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({
    learningEnabled: false,
    memoryMessages: 50,
    merchantPolicy: policy().policy,
  }),
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }),
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), {
  loadActiveLearnedReplies: async () => [],
});
stub(path.resolve(__dirname, '..', 'src', 'workers', 'profile-extractor.js'), {
  getProfile: async () => null,
  extractAsync: () => {},
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), {
  createMailer: () => null,
});
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: { incomingMessages: 'incoming-messages', aiReplies: 'ai-replies', outgoingWhatsapp: 'outgoing-whatsapp' },
  enqueueOutgoingWhatsapp: async () => ({ id: 'out-1' }),
  enqueueAiReply: async () => ({ id: 'ai-1' }),
});

const capturedOpts = [];
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply(history, opts = {}) {
    capturedOpts.push(opts);
    return 'طلبك مُسجّل وقيد المتابعة، وبنوافيك أول ما يجد جديد.';
  }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob() {
  return {
    id: 'job-esc-1',
    data: { userId: 'user-1', conversationId: 'conv-1', messageId: 'inbound-1', sender: '966500000000@s.whatsapp.net', providerMessageId: 'p-in-1' },
    attemptsMade: 0,
  };
}

test('passes escalationPending: true to the model when an unresolved escalation thread exists', async () => {
  capturedOpts.length = 0;
  hasPendingThread = true;

  await processAiReply(makeJob());

  assert.ok(capturedOpts.length >= 1, 'ai.getReply should have been called');
  assert.equal(capturedOpts[0].escalationPending, true);
});

test('escalationPending is falsy when there is no unresolved escalation thread', async () => {
  capturedOpts.length = 0;
  hasPendingThread = false;

  await processAiReply(makeJob());

  assert.ok(capturedOpts.length >= 1, 'ai.getReply should have been called');
  assert.ok(!capturedOpts[0].escalationPending);
});
