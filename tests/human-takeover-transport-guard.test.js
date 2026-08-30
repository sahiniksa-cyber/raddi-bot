'use strict';

// Human Takeover — FINAL transport guard (spec point 7 + test I).
//
// PROVEN ROOT CAUSE (2026-08-30): the owner-pause / takeover check runs ONCE at
// job dequeue (processOutgoingWhatsapp line ~378 main / ~633 @lid), then several
// awaits follow before the real WhatsApp send: quota, idempotency, stale guard,
// waitForConnectedBot (up to 10s), and the pre-send AI review (seconds). If the
// merchant replies manually DURING that window, nothing re-checks the pause at
// the transport chokepoint — the already-in-flight automated reply still ships.
//
// These tests drive the real processOutgoingWhatsapp with a stateful fake db.
// The injected reviewBeforeSend flips the conversation to "owner replied" mid
// review, exactly reproducing the race. A correct final transport guard must
// abort the send and emit no fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Stub the db + quota modules the worker requires at module load. The db stub
// is STATEFUL: `state.ownerReplied` flips the owner-pause query answer so a test
// can simulate the owner replying at any point in the send pipeline.
const state = {
  ownerReplied: false,
  // per (userId|sender) override so multi-tenant isolation can be asserted
  pausedKeys: new Set(),
};

function pauseKey(userId, sender) {
  return `${userId}|${sender}`;
}

const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath,
  filename: dbModulePath + '.js',
  loaded: true,
  exports: {
    isConfigured: () => true,
    query: async (sql, params) => {
      // Owner-pause time-window read: SELECT escalated_until FROM conversations
      if (/SELECT escalated_until FROM conversations/.test(sql)) {
        const [userId, sender] = params;
        const paused = state.ownerReplied || state.pausedKeys.has(pauseKey(userId, sender));
        return { rows: [{ escalated_until: paused ? new Date(Date.now() + 60_000) : null }] };
      }
      // Fact-based owner-reply JOIN — keep it inert here (time-window drives tests)
      if (/JOIN messages hum/.test(sql)) {
        return { rows: [] };
      }
      // isReplyAlreadySent / scope reads / job reads → empty
      return { rows: [], rowCount: 0 };
    },
    getDatabaseUrl: () => 'stub',
    close: async () => {},
  },
};

const quotaModulePath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
require.cache[require.resolve(quotaModulePath)] = {
  id: quotaModulePath,
  filename: quotaModulePath + '.js',
  loaded: true,
  exports: {
    checkMessageQuota: async () => ({ canReply: true, remaining: 10 }),
    decrementMessageQuota: async () => ({ success: true, remaining: 9 }),
  },
};

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');
const validateScope = async () => ({ content: null });

function resetState() {
  state.ownerReplied = false;
  state.pausedKeys = new Set();
}

function makeJob(overrides = {}) {
  return {
    id: overrides.id || 'job-1',
    data: {
      userId: 'user-1',
      conversationId: 'conversation-1',
      sender: '966500000001@s.whatsapp.net',
      reply: 'مسودة',
      replyMessageId: 'reply-1',
      source: 'ai_reply',
      preSendReviewRequired: true,
      ...(overrides.data || {}),
    },
    timestamp: Date.now(),
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: 3 },
  };
}

function makeBot(sent) {
  return {
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running',
    startBot: async () => {},
    sock: { ws: { readyState: 1 } },
    client: {
      sendPresenceUpdate: async () => {},
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
        return { key: { id: 'wa-1' } };
      },
    },
    log: () => {},
  };
}

function withPacingOff(fn) {
  return async (...args) => {
    const prev = process.env.OUTGOING_MIN_INTERVAL_MS;
    process.env.OUTGOING_MIN_INTERVAL_MS = '0';
    try { return await fn(...args); }
    finally {
      if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
      else process.env.OUTGOING_MIN_INTERVAL_MS = prev;
    }
  };
}

// ── I. THE RACE: owner replies WHILE the pre-send review is running. The final
// transport guard (after review, right before send) must block it.
test('I — owner replies during pre-send review → final transport guard blocks the send', withPacingOff(async () => {
  resetState();
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob(), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    // The review itself is where the owner steps in (network/AI latency window).
    reviewBeforeSend: async () => {
      state.ownerReplied = true;
      return { reply: 'النص النهائي', suppressed: false };
    },
  });

  assert.equal(sent.length, 0, 'NO automated message may reach the customer once the owner replied');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'owner_paused_transport_guard');
}));

// ── A. AI reply already queued; the owner replied BEFORE this job runs. The
// early dequeue check must cancel it — the pre-send review never even runs.
test('A — queued AI reply is canceled at dequeue when the owner already replied', withPacingOff(async () => {
  resetState();
  state.ownerReplied = true; // owner replied while the reply sat in the queue
  const sent = [];
  let reviews = 0;
  const result = await processOutgoingWhatsapp(makeJob(), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => { reviews++; return { reply: 'يجب ألا يُرسل', suppressed: false }; },
  });

  assert.equal(sent.length, 0, 'the queued AI reply must never reach the customer');
  assert.equal(reviews, 0, 'the early guard should short-circuit before the pre-send review');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'owner_paused');
}));

// ── J. Restart persistence: after a worker/process restart the takeover is
// still in force because it lives in the DB (conversations.escalated_until).
// A resurrected job reads that state fresh and stays blocked.
test('J — takeover survives a restart (read from DB) and blocks the resurrected job', withPacingOff(async () => {
  resetState();
  // Simulate a brand-new worker process: the only source of truth is the DB row,
  // which still says paused. No in-memory state carried over.
  state.pausedKeys.add(pauseKey('user-1', '966500000001@s.whatsapp.net'));
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({ id: 'job-after-restart', attemptsMade: 0 }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص', suppressed: false }),
  });

  assert.equal(sent.length, 0, 'a job resurrected after restart must honor the persisted takeover');
  assert.equal(result.skipped, true);
}));

// ── I (@lid): same race on the @lid path (≈98% of customers on masked numbers).
test('I (@lid) — owner replies during review → transport guard blocks the @lid send', withPacingOff(async () => {
  resetState();
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({ data: { sender: '278571713060916@lid' } }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => {
      state.ownerReplied = true;
      return { reply: 'النص النهائي', suppressed: false };
    },
  });

  assert.equal(sent.length, 0, 'the @lid transport guard must also block after owner reply');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'owner_paused_transport_guard');
}));

// ── H. Instant/canned reply already past the early check when owner steps in.
test('H — instant reply is blocked at the transport guard when owner replies during review', withPacingOff(async () => {
  resetState();
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({ data: { source: 'auto_reply_keyword' } }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => {
      state.ownerReplied = true;
      return { reply: 'رد جاهز', suppressed: false };
    },
  });

  assert.equal(sent.length, 0, 'instant replies must also be blocked at transport');
  assert.equal(result.reason, 'owner_paused_transport_guard');
}));

// ── G. A retry/recovery resurrection of an in-flight reply must re-check at
// transport. Owner already paused before this attempt runs.
test('G — retry/recovery attempt is blocked because takeover is active', withPacingOff(async () => {
  resetState();
  state.ownerReplied = true; // pause already on record from a previous attempt
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({ attemptsMade: 2 }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص', suppressed: false }),
  });

  assert.equal(sent.length, 0);
  assert.equal(result.skipped, true);
}));

// ── Regression: a genuine escalation/team message must NOT be blocked by the
// owner-pause guard (spec point 9). Escalation payloads bypass the guard.
test('regression — escalation/team message still sends during an owner pause', withPacingOff(async () => {
  resetState();
  state.ownerReplied = true; // customer conversation is paused …
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({
    data: {
      escalation: true,
      customerSender: '966500000001@s.whatsapp.net',
      sender: '966599999999@s.whatsapp.net', // the team/owner destination
      source: 'pre_send_handoff',
      preSendReviewRequired: false,
    },
  }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'تنبيه للفريق', suppressed: false }),
  });

  assert.equal(sent.length, 1, 'the internal escalation notification must still reach the team');
  assert.equal(result.sent, true);
}));

// ── K. Multi-tenant: tenant A paused must not block tenant B's customer send.
test('K — tenant A pause does not affect tenant B (multi-tenant isolation)', withPacingOff(async () => {
  resetState();
  state.pausedKeys.add(pauseKey('user-A', '966500000001@s.whatsapp.net')); // only A is paused
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob({
    data: { userId: 'user-B', sender: '966500000001@s.whatsapp.net' },
  }), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'رد لتاجر ب', suppressed: false }),
  });

  assert.equal(sent.length, 1, 'tenant B must send normally while only tenant A is paused');
  assert.equal(result.sent, true);
}));
