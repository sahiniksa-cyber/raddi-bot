'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub DB + quota so the outgoing worker runs without real infra (same pattern
// as outgoing-pre-send-gate.test.js).
const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath, filename: dbModulePath + '.js', loaded: true,
  exports: { isConfigured: () => true, query: async () => ({ rows: [], rowCount: 0 }), getDatabaseUrl: () => 'stub', close: async () => {} },
};
const quotaModulePath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
require.cache[require.resolve(quotaModulePath)] = {
  id: quotaModulePath, filename: quotaModulePath + '.js', loaded: true,
  exports: { checkMessageQuota: async () => ({ canReply: true, remaining: 10 }), decrementMessageQuota: async () => ({ success: true, remaining: 9 }) },
};

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');
const validateScope = async () => ({ content: null });

function makeJob(sender = '966500000001@s.whatsapp.net') {
  return {
    id: 'job-ov-1',
    data: { userId: 'user-1', conversationId: 'conversation-1', sender, reply: 'رد الذكاء', replyMessageId: 'reply-1', source: 'ai_reply', preSendReviewRequired: true },
    timestamp: Date.now(), attemptsMade: 0, opts: { attempts: 3 },
  };
}
function makeBot(sent) {
  return {
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running', startBot: async () => {},
    sock: { ws: { readyState: 1 } },
    client: {
      sendPresenceUpdate: async () => {},
      // Mirror the real Baileys wrapper: honor the transport-boundary gate.
      sendMessage: async (jid, text, options = {}) => {
        if (options.beforeTransportSend && (await options.beforeTransportSend()) === true) {
          return { aborted: true, reason: 'human_takeover_before_transport' };
        }
        sent.push({ jid, text }); return { key: { id: 'wa-1' } };
      },
    },
    log: () => {},
  };
}
// An owner-pause stub whose verdict follows a scripted sequence of calls, so we
// can simulate the pause flipping true only AFTER the initial guard (i.e. the
// merchant replied during the pre-send window).
function pauseSequence(verdicts) {
  let i = 0;
  const calls = [];
  const fn = async (args) => { calls.push(args); const v = verdicts[Math.min(i, verdicts.length - 1)]; i += 1; return v; };
  fn.calls = calls;
  return fn;
}
async function run(job, deps) {
  const prev = process.env.OUTGOING_MIN_INTERVAL_MS; process.env.OUTGOING_MIN_INTERVAL_MS = '0';
  try { return await processOutgoingWhatsapp(job, deps); }
  finally { if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS; else process.env.OUTGOING_MIN_INTERVAL_MS = prev; }
}

// ── Scenario 1: manual reply lands DURING the pre-send window (race) ──────────
test('normal path: owner replies during the pre-send window → final send BLOCKED', async () => {
  const sent = [];
  const isOwnerPaused = pauseSequence([false, true]); // not paused at start; paused by send time
  const result = await run(makeJob(), {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص النهائي', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0, 'nothing may be sent after takeover');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'owner_paused_presend');
  assert.ok(isOwnerPaused.calls.length >= 2, 'must re-check at the send boundary, not only at job start');
});

test('@lid path (majority of customers): owner replies during pre-send window → send BLOCKED', async () => {
  const sent = [];
  const isOwnerPaused = pauseSequence([false, true]);
  const result = await run(makeJob('12345@lid'), {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص النهائي', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'owner_paused_presend');
});

// ── Scenario 2: pause already active at job start (new customer msg while paused)
test('pause already active at job start → blocked at the start guard (owner_paused)', async () => {
  const sent = [];
  const isOwnerPaused = pauseSequence([true]);
  const result = await run(makeJob(), {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'x', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0);
  assert.equal(result.reason, 'owner_paused');
});

// ── The residual sub-race: manual reply lands DURING sendPresenceUpdate ──────
// Proves the final owner-pause check is the LAST await before the send: the
// merchant's reply happens while the "composing" presence update is in flight,
// AFTER the initial guard passed. The final check must still catch it.
test('normal path: merchant replies DURING sendPresenceUpdate → send BLOCKED (last-await guard)', async () => {
  const sent = [];
  let paused = false;
  const isOwnerPaused = async () => paused; // reflects live state at call time
  const bot = makeBot(sent);
  // The presence update is the point at which the merchant's manual reply lands.
  bot.client.sendPresenceUpdate = async () => { paused = true; };
  const result = await run(makeJob(), {
    getUserBot: async () => bot, scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص النهائي', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0, 'nothing may be sent — the reply landed during presence, before the final check');
  assert.equal(result.reason, 'owner_paused_presend');
});

// ── Lookup race (race 4): merchant replies DURING a whatsapp-web.js getMessageById
// lookup → the gate before original.reply must catch it. ────────────────────
test('lookup race: merchant replies during getMessageById → send BLOCKED (wwjs reply branch)', async () => {
  const sent = [];
  let paused = false;
  const isOwnerPaused = async () => paused;
  const bot = makeBot(sent);
  // whatsapp-web.js-style lookup path: the reply object's send is the transport.
  bot.client.getMessageById = async () => { paused = true; return { reply: async (text) => { sent.push({ jid: 'via-reply', text }); return { key: { id: 'r' } }; } }; };
  const job = makeJob(); job.data.providerMessageId = 'provider-abc';
  const result = await run(job, {
    getUserBot: async () => bot, scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص النهائي', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0, 'no send after takeover that landed during the lookup');
  assert.equal(result.reason, 'owner_paused_presend');
});

// ── Retry/requeue after takeover: a re-run of the job while paused stays blocked.
test('retry after takeover: paused at job start on a retry → blocked (owner_paused)', async () => {
  const sent = [];
  const isOwnerPaused = pauseSequence([true]);
  const job = makeJob(); job.attemptsMade = 2; // a BullMQ retry
  const result = await run(job, {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'x', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(sent.length, 0);
  assert.equal(result.reason, 'owner_paused');
});

// ── Tenant/conversation scope: the gate is asked about THIS job's exact scope. ─
test('tenant isolation: the pause gate is scoped to this job\'s userId + conversationId + sender', async () => {
  const sent = [];
  const seen = [];
  const isOwnerPaused = async (args) => { seen.push(args); return false; };
  await run(makeJob('966500000009@s.whatsapp.net'), {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'رد', suppressed: false }),
    isOwnerPaused,
  });
  assert.ok(seen.length >= 1);
  for (const a of seen) {
    assert.equal(a.userId, 'user-1');
    assert.equal(a.conversationId, 'conversation-1');
    assert.equal(a.sender, '966500000009@s.whatsapp.net');
  }
  // never falsely paused → the reply was delivered
  assert.equal(sent.length, 1);
});

// ── No false positive: never paused → the reply is sent normally ─────────────
test('never paused → reply is sent (no false block from the new re-check)', async () => {
  const sent = [];
  const isOwnerPaused = pauseSequence([false, false]);
  const result = await run(makeJob(), {
    getUserBot: async () => makeBot(sent), scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: 'النص النهائي', suppressed: false }),
    isOwnerPaused,
  });
  assert.equal(result.sent, true);
  assert.deepEqual(sent.map((s) => s.text), ['النص النهائي']);
});
