'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Wiring test: with CONVERSATION_STATE_ENABLED=true, processAiReply must load
// the conversation state (scoped by userId), extract an updated state, persist
// it, and pass conversationState + conversationStateCanInject into ai.getReply.

process.env.CONVERSATION_STATE_ENABLED = 'true';

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

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
      return { rows: [{ content: 'وين طلبي؟' }], rowCount: 1 };
    }
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return { rows: [{ id: 'inbound-1', content: 'وين طلبي؟', provider_message_id: 'p-in-1', raw_payload: {} }], rowCount: 1 };
    }
    if (s.includes('SELECT role, content, status, direction')) {
      return { rows: [{ role: 'user', content: 'وين طلبي؟', status: 'queued_for_ai', direction: 'inbound' }], rowCount: 1 };
    }
    if (s.includes('escalation_threads') && s.includes('resolved_at IS NULL')) {
      return { rows: [], rowCount: 0 };
    }
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
  resolveConfigForAI: async () => ({ learningEnabled: false, memoryMessages: 50 }),
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

let loadedWithUserId = false;
let saved = false;
stub(path.resolve(__dirname, '..', 'src', 'services', 'ai', 'conversation-state.service.js'), {
  async loadConversationState({ userId }) {
    if (userId) loadedWithUserId = true;
    return { state: { open_issues: [], resolved_issues: [] }, extraction_ok: true, reflects_message_id: 'inbound-1', state_version: 3 };
  },
  async saveConversationState() { saved = true; },
  async extractConversationState() {
    return { state: { active_topic: 'shipping', open_issues: [], resolved_issues: [] }, extraction_ok: true };
  },
});

const capturedOpts = [];
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply(history, opts = {}) {
    capturedOpts.push(opts);
    return 'طلبك قيد المتابعة.';
  }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob() {
  return {
    id: 'job-state-1',
    data: { userId: 'user-1', conversationId: 'conv-1', messageId: 'inbound-1', sender: '966500000000@s.whatsapp.net', providerMessageId: 'p-in-1' },
    attemptsMade: 0,
  };
}

test('processAiReply loads state scoped by userId, persists it, and injects into getReply', async () => {
  capturedOpts.length = 0;
  loadedWithUserId = false;
  saved = false;

  await processAiReply(makeJob());

  assert.equal(loadedWithUserId, true, 'loadConversationState should be called with userId');
  assert.equal(saved, true, 'saveConversationState should be called');
  assert.ok(capturedOpts.length >= 1, 'ai.getReply should have been called');
  assert.ok(capturedOpts[0].conversationState, 'conversationState passed to getReply');
  assert.equal(capturedOpts[0].conversationStateCanInject, true, 'canInject true when state reflects latest inbound');
});
