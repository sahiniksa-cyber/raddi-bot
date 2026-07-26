'use strict';

// Tests that team-facing escalation alerts (payload.escalation === true) are
// NEVER billable — decrementMessageQuota must NOT be called for them, while
// the message is still sent (not blocked) even at quota=0.
//
// Control: a normal customer reply (no escalation/systemNotice) still
// decrements quota exactly once on a successful send.

const test = require('node:test');
const assert = require('node:assert/strict');
const { gatewayFactory } = require('./helpers/outgoing-gateway-double');
const path = require('path');

// ── Stub helpers ─────────────────────────────────────────────────────────────

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

// ── Stubs registered BEFORE the worker is loaded ─────────────────────────────

// db/client — used by updateJobStatus / markReplyMessage internally.
const dbPath = path.resolve(__dirname, '..', 'src', 'db', 'client');
stubModule(dbPath, {
  isConfigured: () => true,
  query: async () => ({ rows: [] }),
  getDatabaseUrl: () => 'stub',
  close: async () => {},
});

// Quota module — we track how many times decrement is called.
const quotaPath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
let decrementCalls = 0;
// `quotaStub` is a shared object so per-test mutations to checkMessageQuota
// are visible to the already-loaded module stub.
const quotaStub = {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100 }),
  decrementMessageQuota: async () => {
    decrementCalls++;
    return { success: true, remaining: 99 };
  },
};
stubModule(quotaPath, quotaStub);

// escalation-bridge — recordThreadMessage is a best-effort call in the worker.
const bridgePath = path.resolve(__dirname, '..', 'src', 'services', 'escalation', 'escalation-bridge');
stubModule(bridgePath, {
  recordThreadMessage: async () => {},
});

// ── Load the worker ───────────────────────────────────────────────────────────
// Must happen AFTER db/quota stubs are in require.cache.

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');
const validateScope = async () => ({ content: null });

// ── Bot factory helpers ───────────────────────────────────────────────────────

function makeConnectedBot() {
  return {
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running',
    startBot: async () => {},
    sock: { ws: { readyState: 1 } },
    client: {
      sendPresenceUpdate: async () => {},
      sendMessage: async () => ({ key: { id: 'wamid-test-123' } }),
    },
    log: () => {},
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job-esc-1',
    data: {
      userId: 'user-esc',
      sender: '966500000099@s.whatsapp.net',
      reply: 'تصعيد: العميل يحتاج مساعدة',
      replyMessageId: 'reply-esc-1',
      ...overrides,
    },
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('escalation message is sent but quota is NOT decremented', async () => {
  decrementCalls = 0;
  quotaStub.checkMessageQuota = async () => ({ canReply: true, remaining: 10 });

  const prev = process.env.OUTGOING_MIN_INTERVAL_MS;
  process.env.OUTGOING_MIN_INTERVAL_MS = '0';

  try {
    const result = await processOutgoingWhatsapp(
      makeJob({ escalation: true, customerSender: '966500000001@s.whatsapp.net', conversationId: 'conv-1' }),
      { getUserBot: async () => makeConnectedBot(), scopeValidator: validateScope, gatewayFactory },
    );
    assert.equal(result.sent, true, 'escalation message must be sent');
    assert.equal(decrementCalls, 0, 'quota must NOT be decremented for escalation');
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
    else process.env.OUTGOING_MIN_INTERVAL_MS = prev;
  }
});

test('escalation message is sent even when quota is 0 (never blocked)', async () => {
  decrementCalls = 0;
  // Quota empty — escalation must still go through and must NOT decrement.
  quotaStub.checkMessageQuota = async () => ({ canReply: false, remaining: 0, reason: 'empty' });

  const prev = process.env.OUTGOING_MIN_INTERVAL_MS;
  process.env.OUTGOING_MIN_INTERVAL_MS = '0';

  try {
    const result = await processOutgoingWhatsapp(
      makeJob({ escalation: true, customerSender: '966500000001@s.whatsapp.net', conversationId: 'conv-1' }),
      { getUserBot: async () => makeConnectedBot(), scopeValidator: validateScope, gatewayFactory },
    );
    assert.equal(result.sent, true, 'escalation must be sent even at zero quota');
    assert.equal(decrementCalls, 0, 'quota must NOT be decremented for escalation at zero');
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
    else process.env.OUTGOING_MIN_INTERVAL_MS = prev;
  }
});

test('normal customer reply still decrements quota exactly once on success (control)', async () => {
  decrementCalls = 0;
  quotaStub.checkMessageQuota = async () => ({ canReply: true, remaining: 50 });

  const prev = process.env.OUTGOING_MIN_INTERVAL_MS;
  process.env.OUTGOING_MIN_INTERVAL_MS = '0';

  try {
    const result = await processOutgoingWhatsapp(
      makeJob(), // no escalation flag
      { getUserBot: async () => makeConnectedBot(), gatewayFactory },
    );
    assert.equal(result.sent, true);
    assert.equal(decrementCalls, 1, 'normal reply must decrement quota exactly once');
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
    else process.env.OUTGOING_MIN_INTERVAL_MS = prev;
  }
});
