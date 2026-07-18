'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Reproduction for Issue 1 (duplicate reply). Mirrors the stub-via-require.cache
// harness used by tests/ai-failure-fallback.test.js. We drive processAiReply all
// the way to the reply de-duplication site and assert that when the candidate
// reply AND the regenerated reply are BOTH near-duplicates (Jaccard >= 0.85 after
// normalize) of the most recent assistant reply, the worker does NOT enqueue a
// second outgoing reply — it suppresses it instead.
//
// CONFIRMED ROOT-CAUSE PATH: (a) Regenerate-then-send-original. In ai-worker.js
// (~771-820) findDuplicateRecentReply matches, the worker regenerates once with
// higher penalties, then UNCONDITIONALLY adopts the retry (or keeps the original
// if the retry is empty) and falls through to storeAssistantMessage +
// enqueueOutgoingWhatsapp. It never re-checks whether the regenerated reply is
// still a near-duplicate, so the customer receives a second, differently-worded
// (or identical) reply. (Path (b) follow-up re-answering was NOT the mechanism:
// the duplicate is produced within a SINGLE job run, before any follow-up.)

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

// The most recent assistant reply already stored for this conversation. The AI
// stub returns a near-duplicate of this on BOTH the first generation and the
// regeneration, so the reply must be suppressed.
const EXISTING_REPLY = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين إن شاء الله';
const NEAR_DUPLICATE = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين ان شاء الله';

// Captured side effects.
const outgoingCalls = [];
const insertedAssistantReplies = [];

// In-memory db mock. Routes by SQL substring — only the queries processAiReply
// reaches on the success path need real answers; everything else returns empty.
const dbMock = {
  isConfigured: () => true,
  async query(sql, params) {
    const s = String(sql);

    // resolveConversation — by id
    if (s.includes('FROM conversations') && s.includes('WHERE id = $1 AND user_id = $2')) {
      return { rows: [{ id: 'conv-1', sender: '966500000000@s.whatsapp.net', phone_number: '966500000000' }], rowCount: 1 };
    }
    // isConversationEscalationMuted — not muted
    if (s.includes('escalated_until') && s.includes('escalated_until > NOW()')) {
      return { rows: [], rowCount: 0 };
    }
    // loadInboundMessage (fallback text by id)
    if (s.includes('FROM messages') && s.includes("direction = 'inbound'") && s.includes('WHERE id = $1 AND user_id = $2')) {
      return { rows: [{ content: 'هل التوصيل متوفر؟' }], rowCount: 1 };
    }
    // loadPendingInboundMessages — one pending customer question
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return {
        rows: [{ id: 'inbound-1', content: 'هل التوصيل متوفر؟', provider_message_id: 'p-in-1', raw_payload: {} }],
        rowCount: 1,
      };
    }
    // buildHistoryForReply -> loadHistory: prior assistant reply + the question
    if (s.includes('SELECT role, content, status, direction')) {
      return {
        rows: [
          { role: 'user', content: 'هل التوصيل متوفر؟', status: 'queued_for_ai', direction: 'inbound' },
          { role: 'assistant', content: EXISTING_REPLY, status: 'sent', direction: 'outbound' },
        ],
        rowCount: 2,
      };
    }
    // findDuplicateRecentReply — the most recent assistant reply (the duplicate)
    if (s.includes('FROM messages') && s.includes("direction = 'outbound'") && s.includes("role = 'assistant'") && s.includes('ORDER BY created_at DESC')) {
      return { rows: [{ content: EXISTING_REPLY }], rowCount: 1 };
    }
    // storeAssistantMessage — INSERT ... RETURNING id (should NOT happen if suppressed)
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) {
      const content = params ? params[3] : null;
      insertedAssistantReplies.push(content);
      return { rows: [{ id: `assistant-${insertedAssistantReplies.length}` }], rowCount: 1 };
    }
    // markInboundMessagesAnswered / conversations update / job status / everything else
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);

// runtime-bot — minimal config, no instant replies, learning off.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({
    learningEnabled: false,
    memoryMessages: 50,
    storeDescription: 'متجر تجريبي للاختبار',
  }),
});

// platform-features — no auto/instant replies so we go through the AI path.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});

// quota — never block.
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }),
});

// learned replies — none.
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), {
  loadActiveLearnedReplies: async () => [],
});

// profile extractor — no profile, no-op extraction.
stub(path.resolve(__dirname, '..', 'src', 'workers', 'profile-extractor.js'), {
  getProfile: async () => null,
  extractAsync: () => {},
});

// notify mailer — none.
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), {
  createMailer: () => null,
});

// Capture outgoing enqueues; enqueueAiReply captured too (path b guard).
const aiReplyCalls = [];
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
  enqueueAiReply: async (payload, options) => {
    aiReplyCalls.push({ payload, options });
    return { id: `ai-${aiReplyCalls.length}` };
  },
});

// AI client — controllable per test. By default returns a near-duplicate of the
// existing reply on EVERY call (including the regeneration), simulating the model
// failing to escape the near-duplicate even with higher penalties. A test may
// override `aiReplies` to make the regeneration return a genuinely different reply.
let aiReplies = [NEAR_DUPLICATE, NEAR_DUPLICATE];
let aiCallIndex = 0;
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply() {
    const idx = Math.min(aiCallIndex, aiReplies.length - 1);
    aiCallIndex += 1;
    return aiReplies[idx];
  }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob() {
  return {
    id: 'job-dup-1',
    data: {
      userId: 'user-1',
      conversationId: 'conv-1',
      messageId: 'inbound-1',
      sender: '966500000000@s.whatsapp.net',
      providerMessageId: 'p-in-1',
    },
    attemptsMade: 0,
  };
}

test('suppresses a near-duplicate rephrased reply instead of sending it', async () => {
  outgoingCalls.length = 0;
  insertedAssistantReplies.length = 0;
  aiReplies = [NEAR_DUPLICATE, NEAR_DUPLICATE];
  aiCallIndex = 0;

  const result = await processAiReply(makeJob());

  // No customer-facing reply must be stored or enqueued when both the candidate
  // and the regenerated reply remain near-duplicates of the last assistant reply.
  const customerEnqueues = outgoingCalls.filter(
    c => !c.payload.escalation && c.payload.source !== 'ai_failure_fallback',
  );
  assert.equal(
    customerEnqueues.length,
    0,
    `expected NO second customer reply to be enqueued, got ${customerEnqueues.length}: ${JSON.stringify(customerEnqueues.map(c => c.payload.reply))}`,
  );
  assert.equal(
    insertedAssistantReplies.length,
    0,
    `expected NO assistant reply to be persisted, got: ${JSON.stringify(insertedAssistantReplies)}`,
  );

  // And the job should report it skipped (so the completed-handler follow-up
  // does not re-enqueue and regenerate yet another duplicate).
  assert.equal(result.skipped, true, 'job should return a skipped outcome');
  assert.equal(result.reason, 'duplicate_suppressed');
});

test('still sends when regeneration produces a genuinely different reply', async () => {
  outgoingCalls.length = 0;
  insertedAssistantReplies.length = 0;
  // First generation is a duplicate; the regeneration is a clearly different
  // answer, so the worker MUST send it (no over-suppression).
  const DIFFERENT_REPLY = 'لا للأسف خدمة التوصيل غير متاحة حالياً نعتذر منك';
  aiReplies = [NEAR_DUPLICATE, DIFFERENT_REPLY];
  aiCallIndex = 0;

  const result = await processAiReply(makeJob());

  const customerEnqueues = outgoingCalls.filter(
    c => !c.payload.escalation && c.payload.source !== 'ai_failure_fallback',
  );
  assert.equal(customerEnqueues.length, 1, 'the different reply must be sent');
  assert.equal(customerEnqueues[0].payload.reply, DIFFERENT_REPLY);
  assert.equal(insertedAssistantReplies.length, 1);
  assert.equal(insertedAssistantReplies[0], DIFFERENT_REPLY);
  assert.notEqual(result.skipped, true);
});
