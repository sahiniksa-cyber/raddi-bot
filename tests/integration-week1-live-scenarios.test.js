'use strict';

// Legacy-path regression lock: asserts the CURRENT (default) prompt wording.
// Pin the style/brevity flags OFF so this file deterministically tests the
// legacy path regardless of ambient env. New-path behavior is locked in
// tests/reply-voice-newpath-locks.test.js.
process.env.PROMPT_STYLE_SPLIT_ENABLED = "false";
delete process.env.BREVITY_AUTHORITY_ENABLED;
// ── WEEK-1 END-TO-END INTEGRATION SCENARIOS ─────────────────────────────────
//
// This file drives the REAL bot code (processAiReply, isConversationOwnerPaused,
// shouldBlockOutgoingForQuota, AIClient.buildSystemPrompt) through faithful
// in-memory simulations of a live conversation, to verify the 5 fixes committed
// on this branch actually work end-to-end together. It is stronger than the
// per-fix unit tests because it chains the real functions in coherent scenarios
// and asserts OBSERVABLE outcomes (what reaches the customer).
//
// NO real DB / Redis / WhatsApp is touched — everything is in-memory, reusing
// the exact harness patterns from:
//   - tests/ai-worker-no-duplicate-rephrase.test.js   (require.cache stubs)
//   - tests/ai-worker-quota-stop-message.test.js       (ON CONFLICT emulation)
//   - tests/ai-worker-media-batching.test.js           (buildCombinedInboundText)
//   - tests/owner-interrupt-presend.test.js            (fact-based owner pause db)
//   - tests/ai-prompt-*.test.js                        (AIClient instantiation)
//
// The processAiReply scenarios (1, 2, 5) share ONE in-memory db whose behaviour
// is steered per-test by mutable scenario state, because processAiReply captures
// its `db` / queue dependencies once at module load (via require.cache).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Mutable scenario state shared by the processAiReply scenarios ────────────
const S = {
  // The list of pending inbound customer messages for this run.
  pendingMessages: [],
  // Prior assistant reply already on record (for dedup scenario 2).
  lastAssistantReply: null,
  // Quota gate result.
  quota: { canReply: true, remaining: 100, reason: 'ok' },
  // Platform quota-stop setting.
  quotaStopSetting: null,
  // Whether a prior quota-stop notice already exists (fast-path SELECT).
  priorQuotaNoticeExists: false,
};

// AI client scripted replies (consumed in order). The stub also CAPTURES the
// history it was called with so scenario 1 can assert the combined inbound text.
const ai = {
  replies: [],
  callIndex: 0,
  capturedHistories: [],
};

// Captured side effects.
const outgoingCalls = [];
const insertedAssistantReplies = [];
const insertedNoticeRows = [];

// Emulate the partial unique index uniq_quota_stop_notice_per_conversation.
const quotaStopRowKeys = new Set();

// ── Shared faithful in-memory db (routes by SQL substring) ───────────────────
const dbMock = {
  isConfigured: () => true,
  async query(sql, params) {
    const s = String(sql);

    // platform-settings.getPlatformSetting (platform-settings.js is NOT stubbed).
    if (s.includes('FROM platform_settings') && s.includes('WHERE key = $1')) {
      const key = params && params[0];
      if (key === 'quotaStopMessage') {
        return {
          rows: S.quotaStopSetting ? [{ value: S.quotaStopSetting }] : [],
          rowCount: S.quotaStopSetting ? 1 : 0,
        };
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
      return { rows: [{ content: S.pendingMessages[0]?.content || 'رسالة' }], rowCount: 1 };
    }
    // loadPendingInboundMessages — the scenario's pending customer messages
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      const rows = S.pendingMessages.map((m, i) => ({
        id: m.id || `inbound-${i + 1}`,
        content: m.content,
        provider_message_id: m.provider_message_id || `p-in-${i + 1}`,
        raw_payload: m.raw_payload || { timestamp: Math.floor(Date.now() / 1000) },
      }));
      return { rows, rowCount: rows.length };
    }
    // buildHistoryForReply -> loadHistory. The pending user rows carry
    // status=queued_for_ai so filterHistoryForAi drops them (the worker re-adds
    // the COMBINED text as the final user turn). A prior assistant reply (sent)
    // survives — needed by the dedup scenario.
    if (s.includes('SELECT role, content, status, direction')) {
      const rows = [];
      if (S.lastAssistantReply) {
        rows.push({ role: 'assistant', content: S.lastAssistantReply, status: 'sent', direction: 'outbound' });
      }
      return { rows, rowCount: rows.length };
    }
    // findDuplicateRecentReply — most recent assistant reply
    if (s.includes('FROM messages') && s.includes("direction = 'outbound'") && s.includes("role = 'assistant'") && s.includes('ORDER BY created_at DESC')) {
      return {
        rows: S.lastAssistantReply ? [{ content: S.lastAssistantReply }] : [],
        rowCount: S.lastAssistantReply ? 1 : 0,
      };
    }
    // Prior quota-stop notice detection (once-per-conversation fast-path SELECT).
    if (s.includes('quota_stop') && s.includes('SELECT') && !s.includes('INSERT INTO')) {
      return { rows: S.priorQuotaNoticeExists ? [{ id: 'prior-notice-1' }] : [], rowCount: S.priorQuotaNoticeExists ? 1 : 0 };
    }
    // storeQuotaStopNotice INSERT ... ON CONFLICT DO NOTHING (atomic guard).
    if (s.includes('INSERT INTO messages') && s.includes('quota_stop') && s.includes('ON CONFLICT')) {
      const conversationId = params && params[0];
      const userId = params && params[1];
      const key = `${userId}::${conversationId}`;
      insertedNoticeRows.push({ content: params ? params[3] : null, rawPayload: params ? params[5] : null });
      if (quotaStopRowKeys.has(key)) return { rows: [], rowCount: 0 };
      quotaStopRowKeys.add(key);
      return { rows: [{ id: `notice-${insertedNoticeRows.length}` }], rowCount: 1 };
    }
    // storeAssistantMessage / any other INSERT ... RETURNING id
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) {
      const content = params ? params[3] : null;
      insertedAssistantReplies.push(content);
      return { rows: [{ id: `assistant-${insertedAssistantReplies.length}` }], rowCount: 1 };
    }
    // everything else (mark answered / quota_exceeded / job status / conv update)
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);

// runtime-bot — minimal config, learning off.
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => ({ learningEnabled: false, memoryMessages: 50 }),
});
// platform-features — force the AI path (no auto/instant replies) but DELEGATE
// buildPlatformPromptBlock to the genuine implementation, because the real
// AIClient.buildSystemPrompt (used by the prompt-contract scenarios 1c/4) calls
// it. Loading the real module first keeps the prompt build faithful while still
// disabling instant/auto replies for processAiReply.
const realPlatformFeatures = require('../src/services/bot/platform-features');
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  ...realPlatformFeatures,
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});
// quota — steered by S.quota.
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => S.quota,
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

// AI client stub: scripted replies + history capture. Throws if called on the
// quota-exhausted path (that branch must return before reaching the AI).
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() {}
  async getReply(history) {
    ai.capturedHistories.push(history);
    const idx = Math.min(ai.callIndex, ai.replies.length - 1);
    ai.callIndex += 1;
    return ai.replies[idx];
  }
});

// Capture outgoing enqueues.
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: { incomingMessages: 'incoming-messages', aiReplies: 'ai-replies', outgoingWhatsapp: 'outgoing-whatsapp' },
  enqueueOutgoingWhatsapp: async (payload, options) => {
    outgoingCalls.push({ payload, options });
    return { id: `out-${outgoingCalls.length}` };
  },
  enqueueAiReply: async () => ({ id: 'ai-x' }),
});

// REAL functions under test. processAiReply / outgoing worker captured the
// stubbed ai-client at load (they only need getReply), which is what we want.
const { processAiReply } = require('../src/workers/ai-worker');
const {
  isConversationOwnerPaused,
  shouldBlockOutgoingForQuota,
} = require('../src/workers/outgoing-whatsapp-worker');
const { DEFAULT_CONFIG } = require('../lib/constants');

// The prompt-contract scenarios (1c, 4) need the GENUINE AIClient.buildSystemPrompt,
// not the getReply-only stub installed above. Load the real module by evicting
// the stub from require.cache for one fresh require, then restore the stub so the
// already-captured worker reference (and any future require) keeps the stub.
const aiClientPath = require.resolve('../lib/ai-client');
const stubbedAiClientEntry = require.cache[aiClientPath];
delete require.cache[aiClientPath];
const AIClient = require('../lib/ai-client');
require.cache[aiClientPath] = stubbedAiClientEntry;

function makeJob() {
  return {
    id: 'job-int-1',
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

function resetState() {
  S.pendingMessages = [];
  S.lastAssistantReply = null;
  S.quota = { canReply: true, remaining: 100, reason: 'ok' };
  S.quotaStopSetting = null;
  S.priorQuotaNoticeExists = false;
  ai.replies = [];
  ai.callIndex = 0;
  ai.capturedHistories.length = 0;
  outgoingCalls.length = 0;
  insertedAssistantReplies.length = 0;
  insertedNoticeRows.length = 0;
  quotaStopRowKeys.clear();
}

// Helper: only customer-facing enqueues (exclude escalation / ai_failure filler).
function customerEnqueues() {
  return outgoingCalls.filter(c => !c.payload.escalation && c.payload.source !== 'ai_failure_fallback');
}

function createPromptClient(config) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...config },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {} },
  );
}

// ── SCENARIO 1 — Multiple questions → one combined reply (Issue 3) ───────────
test('SCENARIO 1: three rapid customer messages produce ONE combined prompt and ONE reply', async () => {
  resetState();
  S.pendingMessages = [
    { id: 'in-1', content: 'السلام عليكم' },
    { id: 'in-2', content: 'كم سعر المنتج؟' },
    { id: 'in-3', content: 'وهل فيه ضمان؟' },
  ];
  ai.replies = ['وعليكم السلام، السعر 100 ريال والضمان سنة كاملة'];

  const result = await processAiReply(makeJob());

  // (a) The REAL buildCombinedInboundText + buildHistoryForReply combined all
  // three messages into the single user turn handed to the AI client.
  assert.equal(ai.capturedHistories.length, 1, 'AI must be called exactly once for the batch');
  const history = ai.capturedHistories[0];
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  assert.ok(lastUser, 'a combined user turn must be present');
  assert.match(lastUser.content, /رسائل متتالية من نفس العميل/, 'the combine directive must be present');
  for (const part of ['السلام عليكم', 'كم سعر المنتج؟', 'وهل فيه ضمان؟']) {
    assert.ok(lastUser.content.includes(part), `combined prompt must contain "${part}"`);
  }

  // (b) Exactly ONE customer reply was enqueued (not three).
  assert.equal(customerEnqueues().length, 1, 'exactly one combined reply must be enqueued');
  assert.equal(customerEnqueues()[0].payload.reply, 'وعليكم السلام، السعر 100 ريال والضمان سنة كاملة');
  assert.notEqual(result.skipped, true, 'the job must produce a reply, not skip');

  // (c) The REAL system prompt carries the "answer every question" rule and NOT
  // the old contradictory single-path phrase.
  const sys = createPromptClient({ storeName: 'متجر اختبار' })
    .buildSystemPrompt([{ role: 'user', content: 'كم السعر؟ وهل يتوفر؟' }], {});
  assert.match(sys, /جاوب على (جميع|كل) الأسئلة/, 'prompt must instruct answering all questions');
  assert.doesNotMatch(sys, /مساراً واحداً واضحاً فقط/, 'old contradictory phrase must be gone');
});

// ── SCENARIO 2 — Duplicate suppression (Issue 1) ─────────────────────────────
test('SCENARIO 2: a near-duplicate reply (and near-duplicate regeneration) is suppressed', async () => {
  resetState();
  const EXISTING = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين إن شاء الله';
  const NEAR_DUP = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين ان شاء الله';
  S.lastAssistantReply = EXISTING;
  S.pendingMessages = [{ id: 'in-1', content: 'هل التوصيل متوفر؟' }];
  // Both the first generation and the regeneration stay near-duplicates.
  ai.replies = [NEAR_DUP, NEAR_DUP];

  const result = await processAiReply(makeJob());

  assert.equal(customerEnqueues().length, 0, 'no customer reply may be enqueued when both candidate + regen are near-duplicates');
  assert.equal(insertedAssistantReplies.length, 0, 'no assistant reply may be persisted');
  assert.equal(result.skipped, true, 'job must report a skip');
  assert.equal(result.reason, 'duplicate_suppressed', 'reason must be duplicate_suppressed');
});

test('SCENARIO 2b (no over-suppression): a genuinely different regeneration is still sent', async () => {
  resetState();
  const EXISTING = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين إن شاء الله';
  const NEAR_DUP = 'نعم التوصيل متوفر لجميع مدن المملكة خلال يومين ان شاء الله';
  const DIFFERENT = 'لا للأسف خدمة التوصيل غير متاحة حالياً نعتذر منك';
  S.lastAssistantReply = EXISTING;
  S.pendingMessages = [{ id: 'in-1', content: 'هل التوصيل متوفر؟' }];
  ai.replies = [NEAR_DUP, DIFFERENT];

  const result = await processAiReply(makeJob());

  assert.equal(customerEnqueues().length, 1, 'the genuinely different reply must be sent');
  assert.equal(customerEnqueues()[0].payload.reply, DIFFERENT);
  assert.notEqual(result.skipped, true);
});

// ── SCENARIO 3 — Owner interrupt (Issue 2) ───────────────────────────────────
// Reuses the faithful fact-based db from tests/owner-interrupt-presend.test.js
// and drives the REAL isConversationOwnerPaused. The key case is the same-tick
// fast owner reply (>= comparison), which used to slip through with strict `>`.
function createFactBasedDb({ rows }) {
  return {
    isConfigured: () => true,
    query: async (sql, params) => {
      if (/SELECT escalated_until FROM conversations/.test(sql)) {
        return { rows: [{ escalated_until: null }] }; // flag NOT set
      }
      if (/JOIN messages hum/.test(sql)) {
        const aiId = params[0];
        const aiRow = rows.find(r => r.id === aiId);
        if (!aiRow) return { rows: [] };
        const cmpGreaterOrEqual = /hum\.created_at >= ai\.created_at/.test(sql);
        const match = rows.some(hum => {
          if (hum.id === aiRow.id) return false;
          if (hum.conversation_id !== aiRow.conversation_id) return false;
          if (hum.direction !== 'outbound') return false;
          const isHuman = hum.status === 'sent_by_human'
            || (hum.status === 'sent' && hum.raw_payload?.source === 'manual_send');
          if (!isHuman) return false;
          return cmpGreaterOrEqual ? hum.created_at >= aiRow.created_at : hum.created_at > aiRow.created_at;
        });
        return { rows: match ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('SCENARIO 3: a same-tick fast owner reply cancels the in-flight AI reply', async () => {
  const t0 = 1_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-1', conversation_id: 'c1', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      { id: 'hum-1', conversation_id: 'c1', direction: 'outbound', status: 'sent_by_human', created_at: t0 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-1', database,
  });
  assert.equal(paused, true, 'same-millisecond owner reply must cancel the AI reply (>= comparison)');
});

test('SCENARIO 3b: the bot does NOT cancel itself on its own later AI send', async () => {
  const t0 = 3_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-3', conversation_id: 'c3', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      { id: 'ai-3b', conversation_id: 'c3', direction: 'outbound', status: 'sent', raw_payload: { source: 'ai' }, created_at: t0 + 1000 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-3', database,
  });
  assert.equal(paused, false, 'a later AI send is not an owner reply — must not self-cancel');
});

// ── SCENARIO 4 — No-guess on not-understood (Issue 4) ────────────────────────
// Instruction-level guarantee in the REAL system prompt. NOTE: true model
// adherence (the model actually clarifying instead of hallucinating) cannot be
// verified in-process without a real LLM — only the prompt contract is asserted.
test('SCENARIO 4: the real system prompt forbids guessing and requires clarify-or-escalate', () => {
  const sys = createPromptClient({ storeName: 'متجر اختبار' })
    .buildSystemPrompt([{ role: 'user', content: 'شيء غير واضح' }], {});
  assert.match(sys, /إذا لم تفهم طلب العميل/, 'prompt must address the not-understood case');
  assert.match(sys, /اطلب توضيح|صعّد/, 'prompt must require asking for clarification or escalating');
});

// ── SCENARIO 5 — Quota stop message once per customer (Issue 5) ──────────────
test('SCENARIO 5a: quota empty + enabled setting → ONE systemNotice stop message; second inbound is silent', async () => {
  resetState();
  S.quota = { canReply: false, remaining: 0, reason: 'quota_exhausted' };
  S.quotaStopSetting = { enabled: true, text: 'انتهى رصيد الردود التلقائية مؤقتاً' };
  S.pendingMessages = [{ id: 'in-1', content: 'السلام عليكم' }];

  // First inbound → exactly ONE notice enqueued, flagged systemNotice + quota_stop.
  const r1 = await processAiReply(makeJob());
  assert.equal(r1.skipped, true, 'quota-empty inbound stays in the skipped/silent outcome');
  assert.equal(outgoingCalls.length, 1, 'exactly ONE notice on the first inbound');
  const notice = outgoingCalls[0].payload;
  assert.equal(notice.reply, 'انتهى رصيد الردود التلقائية مؤقتاً', 'notice text comes from the platform setting');
  assert.equal(notice.systemNotice, true, 'notice must be flagged systemNotice');
  assert.equal(notice.kind, 'quota_stop', 'notice must carry kind=quota_stop');

  // Second inbound in the SAME conversation → atomic ON CONFLICT → no new notice.
  // (priorQuotaNoticeExists stays false to force the race down to the INSERT, so
  // it is the atomic guard — not the fast-path SELECT — that prevents the double.)
  const r2 = await processAiReply(makeJob());
  assert.equal(r2.skipped, true);
  assert.equal(outgoingCalls.length, 1, 'a second inbound must NOT enqueue another notice (once per customer)');
});

test('SCENARIO 5b: quota empty + disabled/absent setting → silent (no notice)', async () => {
  resetState();
  S.quota = { canReply: false, remaining: 0, reason: 'quota_exhausted' };
  S.pendingMessages = [{ id: 'in-1', content: 'السلام عليكم' }];

  // disabled
  S.quotaStopSetting = { enabled: false, text: 'نص' };
  const r1 = await processAiReply(makeJob());
  assert.equal(r1.skipped, true);
  assert.equal(outgoingCalls.length, 0, 'disabled setting → no notice');

  // absent
  resetState();
  S.quota = { canReply: false, remaining: 0, reason: 'quota_exhausted' };
  S.pendingMessages = [{ id: 'in-1', content: 'السلام عليكم' }];
  S.quotaStopSetting = null;
  const r2 = await processAiReply(makeJob());
  assert.equal(r2.skipped, true);
  assert.equal(outgoingCalls.length, 0, 'absent setting → no notice');
});

test('SCENARIO 5c: the quota gate treats the notice and a normal reply correctly', () => {
  // The systemNotice notice must NOT be blocked at the outgoing quota chokepoint
  // (it is sent precisely because the balance is empty).
  assert.equal(
    shouldBlockOutgoingForQuota({ systemNotice: true, kind: 'quota_stop' }, { canReply: false }),
    false,
    'a systemNotice payload must bypass the quota gate',
  );
  // A normal customer reply at zero quota MUST be blocked.
  assert.equal(
    shouldBlockOutgoingForQuota({ reply: 'رد عادي' }, { canReply: false }),
    true,
    'a normal reply at zero quota must be blocked',
  );
});
