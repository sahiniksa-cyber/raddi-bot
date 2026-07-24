'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Task 8 — platform quota-stop message. When a merchant's message quota is
// exhausted the bot normally goes SILENT. With the platform setting
// quotaStopMessage = { enabled, text } turned on, the bot must send that text
// to the customer EXACTLY ONCE per conversation (then stay silent), as a system
// notice that is NOT blocked by the quota gate and does NOT decrement quota.
//
// Mirrors the require.cache stub harness used by
// tests/ai-worker-no-duplicate-rephrase.test.js. We drive processAiReply into
// the quota-exhausted branch (checkMessageQuota -> canReply:false) and assert
// the notice behavior via the captured outgoing enqueues + DB inserts.

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

// Captured side effects.
const outgoingCalls = [];
const insertedMessages = [];

// Emulates the partial unique index uniq_quota_stop_notice_per_conversation:
// tracks which (user_id, conversation_id) pairs already hold a quota_stop row so
// a second INSERT ... ON CONFLICT DO NOTHING returns no id (rows: []).
const quotaStopRowKeys = new Set();

// Controls per-test: whether a prior quota_stop notice already exists, and what
// the platform setting returns.
let priorNoticeExists = false;
let platformQuotaStopSetting = null;

// In-memory db mock. Routes by SQL substring. platform-settings.js uses this
// same db/client (it is NOT stubbed), so the SELECT ... FROM platform_settings
// query is answered here too.
const dbMock = {
  isConfigured: () => true,
  async query(sql, params) {
    const s = String(sql);

    // platform-settings.getPlatformSetting
    if (s.includes('FROM platform_settings') && s.includes('WHERE key = $1')) {
      const key = params && params[0];
      if (key === 'quotaStopMessage') {
        return { rows: platformQuotaStopSetting ? [{ value: platformQuotaStopSetting }] : [], rowCount: platformQuotaStopSetting ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }

    // resolveConversation — by id
    if (s.includes('FROM conversations')
        && s.includes('WHERE id = $1')
        && s.includes('user_id = $2')
        && !s.includes('escalated_until')) {
      return { rows: [{ id: 'conv-1', sender: '966500000000@s.whatsapp.net', phone_number: '966500000000' }], rowCount: 1 };
    }
    // isConversationEscalationMuted — not muted
    if (s.includes('escalated_until') && s.includes('escalated_until > NOW()')) {
      return { rows: [], rowCount: 0 };
    }
    // loadInboundMessage (fallback text by id)
    if (s.includes('FROM messages') && s.includes("direction = 'inbound'") && s.includes('WHERE id = $1') && s.includes('user_id = $2')) {
      return { rows: [{ content: 'هل التوصيل متوفر؟' }], rowCount: 1 };
    }
    // loadPendingInboundMessages — one pending customer question (fresh timestamp)
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return {
        rows: [{ id: 'inbound-1', content: 'هل التوصيل متوفر؟', provider_message_id: 'p-in-1', raw_payload: { timestamp: Math.floor(Date.now() / 1000) } }],
        rowCount: 1,
      };
    }
    // Prior quota-stop notice detection (once-per-conversation guard SELECT).
    // Must be matched BEFORE the generic INSERT routing below, but must NOT
    // intercept the storeQuotaStopNotice INSERT (which also mentions quota_stop
    // in its ON CONFLICT predicate) — hence the explicit SELECT/INSERT guard.
    if (s.includes('quota_stop') && s.includes('SELECT') && !s.includes('INSERT INTO')) {
      return { rows: priorNoticeExists ? [{ id: 'prior-notice-1' }] : [], rowCount: priorNoticeExists ? 1 : 0 };
    }
    // storeQuotaStopNotice INSERT ... ON CONFLICT DO NOTHING. Emulate the
    // partial unique index: the FIRST insert for a (user_id, conversation_id)
    // pair succeeds and returns an id; a SECOND insert for the same pair
    // conflicts → DO NOTHING → no row returned (rows: []), so the caller gets
    // null and must NOT enqueue. This is the atomic guard under test.
    if (s.includes('INSERT INTO messages') && s.includes('quota_stop') && s.includes('ON CONFLICT')) {
      const userId = params && params[1];
      const conversationId = params && params[0];
      const key = `${userId}::${conversationId}`;
      insertedMessages.push({ content: params ? params[3] : null, rawPayload: params ? params[5] : null });
      if (quotaStopRowKeys.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      quotaStopRowKeys.add(key);
      return { rows: [{ id: `msg-${insertedMessages.length}` }], rowCount: 1 };
    }
    // storeAssistantMessage / any other INSERT ... RETURNING id
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) {
      insertedMessages.push({ content: params ? params[3] : null, rawPayload: params ? params[5] : null });
      return { rows: [{ id: `msg-${insertedMessages.length}` }], rowCount: 1 };
    }
    // everything else (mark quota_exceeded, job status, conversations update, ...)
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);

// runtime-bot — minimal config, learning off.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({ learningEnabled: false, memoryMessages: 50 }),
});

// platform-features — no auto/instant replies.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});

// quota — ALWAYS exhausted for these tests.
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: false, remaining: 0, reason: 'quota_exhausted' }),
});

// learned replies — none.
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), {
  loadActiveLearnedReplies: async () => [],
});

// profile extractor — none.
stub(path.resolve(__dirname, '..', 'src', 'workers', 'profile-extractor.js'), {
  getProfile: async () => null,
  extractAsync: () => {},
});

// notify mailer — none.
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), {
  createMailer: () => null,
});

// AI client — must NOT be called on the quota branch (the branch returns early).
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply() { throw new Error('ai.getReply must not run on quota-exhausted path'); }
});

// Capture outgoing enqueues.
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
  enqueueAiReply: async () => ({ id: 'ai-x' }),
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob() {
  return {
    id: 'job-quota-stop-1',
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

function reset() {
  outgoingCalls.length = 0;
  insertedMessages.length = 0;
  quotaStopRowKeys.clear();
  priorNoticeExists = false;
  platformQuotaStopSetting = null;
}

test('(a) quota empty + enabled setting + no prior notice → sends ONE system-notice stop message, no decrement', async () => {
  reset();
  platformQuotaStopSetting = { enabled: true, text: 'رسالة التوقف' };

  const result = await processAiReply(makeJob());

  // Stays in the silent/skipped outcome for the inbound (no AI reply).
  assert.equal(result.skipped, true);

  // Exactly ONE outgoing enqueue, carrying the stop text and the systemNotice flag.
  assert.equal(outgoingCalls.length, 1, `expected exactly ONE outgoing enqueue, got ${outgoingCalls.length}`);
  const sent = outgoingCalls[0].payload;
  assert.equal(sent.reply, 'رسالة التوقف', 'enqueued reply must be the platform stop text');
  assert.equal(sent.systemNotice, true, 'enqueued payload must be flagged systemNotice so the quota gate does not block it');
  assert.equal(sent.kind, 'quota_stop', 'enqueued payload must carry kind=quota_stop');

  // The notice was persisted tagged with kind=quota_stop (for the once-per-convo guard).
  const noticeRows = insertedMessages.filter(m => String(m.rawPayload || '').includes('quota_stop'));
  assert.equal(noticeRows.length, 1, 'the notice must be stored tagged kind=quota_stop');
  assert.ok(String(noticeRows[0].content).includes('رسالة التوقف'), 'stored notice content must be the stop text');
});

test('(b) quota empty + enabled setting + prior notice already exists → stays silent (no new enqueue)', async () => {
  reset();
  platformQuotaStopSetting = { enabled: true, text: 'رسالة التوقف' };
  priorNoticeExists = true;

  const result = await processAiReply(makeJob());

  assert.equal(result.skipped, true);
  assert.equal(outgoingCalls.length, 0, `expected NO outgoing enqueue on a second inbound, got ${outgoingCalls.length}`);
});

test('(c) quota empty + setting disabled/null → stays silent (current behavior preserved)', async () => {
  reset();
  platformQuotaStopSetting = { enabled: false, text: 'رسالة التوقف' };

  const result1 = await processAiReply(makeJob());
  assert.equal(result1.skipped, true);
  assert.equal(outgoingCalls.length, 0, 'disabled setting must not enqueue anything');

  // null setting (key missing) is also silent.
  reset();
  platformQuotaStopSetting = null;
  const result2 = await processAiReply(makeJob());
  assert.equal(result2.skipped, true);
  assert.equal(outgoingCalls.length, 0, 'missing setting must not enqueue anything');
});

test('(d) two concurrent jobs, same conversation → atomic insert lets only ONE enqueue (no double-send)', async () => {
  reset();
  platformQuotaStopSetting = { enabled: true, text: 'رسالة التوقف' };
  // priorNoticeExists stays FALSE: this simulates the race where BOTH jobs pass
  // the cheap SELECT fast-path (no prior notice visible yet) and both reach the
  // INSERT. The partial-unique-index emulation makes the SECOND insert conflict
  // → returns no id → that job must NOT enqueue. The atomic guard, not the
  // racy SELECT, is what prevents the double-send.
  const r1 = await processAiReply(makeJob());
  const r2 = await processAiReply(makeJob());

  assert.equal(r1.skipped, true);
  assert.equal(r2.skipped, true);

  // Both jobs attempted an insert (both passed the SELECT), but only the first
  // won the row → exactly ONE outgoing enqueue. If the code enqueued on a null
  // id this would be 2 and the test fails — pinning the atomic guard.
  assert.equal(outgoingCalls.length, 1, `expected exactly ONE enqueue across two concurrent jobs, got ${outgoingCalls.length}`);
  const sent = outgoingCalls[0].payload;
  assert.equal(sent.reply, 'رسالة التوقف');
  assert.equal(sent.kind, 'quota_stop');
});
