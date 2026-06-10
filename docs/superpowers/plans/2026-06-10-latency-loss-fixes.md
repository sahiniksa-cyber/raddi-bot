# WhatsApp Reply Latency & Silent-Loss Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the confirmed code-level causes of 10+ minute reply delays and silently-lost replies in the Raddi WhatsApp bot (6 targeted fixes + verification).

**Architecture:** All fixes are small, surgical changes to the existing message pipeline (Baileys → ingest → BullMQ → ai-worker → outgoing worker). No schema changes, no new dependencies, no behavior changes for healthy-path conversations. Every fix ships behind the existing env-var override pattern so production can revert any single knob without a deploy.

**Tech Stack:** Node.js 18, BullMQ, PostgreSQL, `node:test` for tests (run with `node --test tests/<file>`).

**Verified-out-of-scope (checked, already handled — do NOT touch):**
- Media-without-caption "empty inbound text": ingest already stores `[صورة من العميل]` as content and `ai-worker.js:555-583` already skips gracefully without retry-loops. Changing this risks new behavior.
- Owner reply from phone setting the pause: `message-ingest.service.js` already sets `escalated_until` on `fromMe` (see `tests/owner-pause.test.js`). The only gap is the outgoing worker not *honoring* it (Task 5).
- Humanization delay (50-75s): intentional product behavior, configurable per-merchant in the dashboard. Not a code fix.

---

### Task 1: Revive the dead-socket guard (`RuntimeBot.sock` getter)

**Why:** `isSocketOpen(bot)` in the outgoing worker reads `bot.sock`, but `RuntimeBot` never exposes `sock` — so the guard always returns `true` and replies are sent into dead websockets and silently lost.

**Files:**
- Modify: `src/services/bot/runtime-bot.js:205-207` (right after `get client()`)
- Test: `tests/runtime-bot-sock-getter.test.js` (new)

**Regression safety:** The getter delegates live to `this.connection.sock` (never pins a stale reference — the concern in `outgoing-whatsapp-worker.js:166-168` comments is about *capturing* the value, not reading it at check time). For whatsapp-web.js engine `connection.sock` is `undefined`, so `isSocketOpen` falls through to `return true` exactly as before — zero behavior change for that engine.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-bot-sock-getter.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');
const { isSocketOpen } = require('../src/workers/outgoing-whatsapp-worker');

test('RuntimeBot exposes a live sock getter delegating to connection.sock', () => {
  const desc = Object.getOwnPropertyDescriptor(RuntimeBot.prototype, 'sock');
  assert.ok(desc && typeof desc.get === 'function', 'RuntimeBot.prototype.sock getter must exist');

  const fakeSock = { ws: { readyState: 1 } };
  assert.equal(desc.get.call({ connection: { sock: fakeSock } }), fakeSock);
  assert.equal(desc.get.call({ connection: {} }), undefined);
});

test('isSocketOpen detects a dead Baileys websocket through the RuntimeBot getter', () => {
  const desc = Object.getOwnPropertyDescriptor(RuntimeBot.prototype, 'sock');
  const botWith = (readyState) => {
    const self = { connection: { sock: { ws: { readyState } } } };
    return { get sock() { return desc.get.call(self); } };
  };

  assert.equal(isSocketOpen(botWith(1)), true);   // OPEN
  assert.equal(isSocketOpen(botWith(3)), false);  // CLOSED — the guard finally works
  assert.equal(isSocketOpen(botWith(0)), false);  // CONNECTING — not safe to send

  // whatsapp-web.js style bot without sock must still be accepted (unchanged)
  assert.equal(isSocketOpen({}), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime-bot-sock-getter.test.js`
Expected: FAIL with "RuntimeBot.prototype.sock getter must exist"

- [ ] **Step 3: Implement the getter**

In `src/services/bot/runtime-bot.js`, directly after the `get client()` block (lines 205-207):

```js
  get client() {
    return this.connection.client;
  }

  // Live view of the underlying Baileys socket so the outgoing worker's
  // isSocketOpen() guard can inspect ws.readyState. Reading at call time
  // (not capturing) means it never pins a dead socket across reconnects.
  // whatsapp-web.js engine has no sock — getter returns undefined and the
  // guard falls through to "open", same as before.
  get sock() {
    return this.connection?.sock;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime-bot-sock-getter.test.js`
Expected: PASS (4 assertions, 2 tests)

- [ ] **Step 5: Run neighbors to catch regressions**

Run: `node --test tests/outgoing-worker-stop.test.js tests/outgoing-conn-conflict-guard.test.js tests/outgoing-double-send-prevented.test.js`
Expected: PASS (these exercise the outgoing worker paths around `isSocketOpen`)

- [ ] **Step 6: Commit**

```bash
git add tests/runtime-bot-sock-getter.test.js src/services/bot/runtime-bot.js
git commit -m "fix(whatsapp): expose RuntimeBot.sock so the dead-socket send guard actually works"
```

---

### Task 2: Start button works while stuck `reconnecting`

**Why:** `bot.controller.js:69` always calls `startBot()`, but the Baileys manager's `start()` returns `false` when `_running === true` — which it is during the whole reconnect backoff window (10-60s). The user presses Start, gets "بدأ التشغيل", and nothing happens. `restartBot()` (already exists at `runtime-bot.js:488`, used by the restart endpoint) force-stops then starts.

**Files:**
- Modify: `src/controllers/bot.controller.js:61-77`
- Test: `tests/bot-controller-start-feedback.test.js` (extend)

**Regression safety:** Only the `reconnecting` state is routed to `restartBot()`. All other states (`stopped`, `waiting_qr`, `connecting`, `connected`) keep the exact current `startBot()` path — and `connecting` deliberately stays on `startBot()` so the button can't kill an in-flight healthy handshake. The fire-and-forget non-blocking response shape is preserved (existing tests enforce it).

- [ ] **Step 1: Write the failing test**

Append to `tests/bot-controller-start-feedback.test.js`:

```js
test('start uses restartBot when the connection is stuck reconnecting', async () => {
  let restartCalled = false;
  let startCalled = false;
  const controller = createBotController({
    getUserBot: () => ({
      startBot: async () => { startCalled = true; return false; },
      restartBot: async () => { restartCalled = true; return true; },
      appState: { status: 'reconnecting', error: null },
    }),
  });
  const res = createResponse();

  await controller.start({ session: { userId: 'user-1' } }, res);

  assert.equal(res.body.success, true);
  await Promise.resolve();
  assert.equal(restartCalled, true, 'must force-restart during reconnect backoff');
  assert.equal(startCalled, false, 'plain startBot is a no-op while _running=true');
});

test('start keeps using startBot for non-reconnecting states', async () => {
  let restartCalled = false;
  let startCalled = false;
  const controller = createBotController({
    getUserBot: () => ({
      startBot: async () => { startCalled = true; return true; },
      restartBot: async () => { restartCalled = true; return true; },
      appState: { status: 'stopped', error: null },
    }),
  });
  const res = createResponse();

  await controller.start({ session: { userId: 'user-1' } }, res);

  await Promise.resolve();
  assert.equal(startCalled, true);
  assert.equal(restartCalled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-controller-start-feedback.test.js`
Expected: FAIL — `restartCalled` is `false` (current code always calls startBot)

- [ ] **Step 3: Implement the routing**

In `src/controllers/bot.controller.js`, replace the `start` handler body (lines 61-77):

```js
    async start(req, res) {
      const bot = getUserBot(req.session.userId);
      // Do NOT await the full connection handshake here. connection.start()
      // performs network work (fetchLatestBaileysVersion + socket handshake)
      // that can take ~20s, which would hang the button and the page. Kick it
      // off in the background and respond immediately; the dashboard polls
      // /api/status and /api/qr to reflect the real state as it progresses.
      //
      // While the manager is mid-reconnect (_running still true for the whole
      // backoff window) a plain startBot() is silently ignored — route the
      // button through restartBot() so it force-stops and reconnects now.
      const stuckReconnecting = bot.appState.status === 'reconnecting';
      Promise.resolve()
        .then(() => (stuckReconnecting ? bot.restartBot() : bot.startBot()))
        .catch((err) => { try { bot.log?.(`start failed: ${err.message}`); } catch (_) {} });
      res.json({
        success: true,
        started: true,
        status: bot.appState.status,
        message: 'بدأ التشغيل — انتظر ظهور الباركود أو الاتصال خلال لحظات.',
      });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-controller-start-feedback.test.js`
Expected: PASS (all tests in the file, including the 2 pre-existing non-blocking tests)

- [ ] **Step 5: Commit**

```bash
git add tests/bot-controller-start-feedback.test.js src/controllers/bot.controller.js
git commit -m "fix(dashboard): Start button force-restarts when stuck reconnecting instead of no-op"
```

---

### Task 3: Stop silently dropping replies after 10 minutes (10 → 30 min default)

**Why:** `OUTGOING_STALE_JOB_MAX_AGE_MS` defaults to 600000 (10 min) in two places. A connection outage of ~10 minutes (one bad reconnect ladder is enough) makes every queued reply expire silently — the customer never gets anything and nobody knows. 30 minutes matches `AI_PENDING_MAX_AGE_MS` (the inbound side already uses 1800000), making the pipeline symmetric.

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js:85` and `:368`
- Test: `tests/outgoing-stale.test.js` (extend)

**Regression safety:** Escalation messages keep their separate 60-min cap (`ESCALATION_MAX_AGE_MS`, untouched). The existing tests pass `maxAgeMs` explicitly so they are unaffected. Env override behavior is identical — production can set `OUTGOING_STALE_JOB_MAX_AGE_MS=600000` to restore the old value instantly. Worst regression case: a customer receives a reply 25 minutes late instead of never — strictly better for a sales bot.

- [ ] **Step 1: Write the failing test**

Append to `tests/outgoing-stale.test.js` (add `outgoingStaleMaxAgeMs` to the require at the top):

```js
const {
  shouldSkipStaleOutgoingPayload,
  outgoingStaleMaxAgeMs,
} = require('../src/workers/outgoing-whatsapp-worker');

test('stale window defaults to 30 minutes and honors the env override', () => {
  const prev = process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
  delete process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
  try {
    assert.equal(outgoingStaleMaxAgeMs(), 30 * 60 * 1000);
    process.env.OUTGOING_STALE_JOB_MAX_AGE_MS = '600000';
    assert.equal(outgoingStaleMaxAgeMs(), 600000);
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
    else process.env.OUTGOING_STALE_JOB_MAX_AGE_MS = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/outgoing-stale.test.js`
Expected: FAIL with "outgoingStaleMaxAgeMs is not a function"

- [ ] **Step 3: Implement the shared helper**

In `src/workers/outgoing-whatsapp-worker.js`, add below `ESCALATION_MAX_AGE_MS` (line 73):

```js
// 30 minutes: long enough to ride out a full reconnect ladder + outgoing retry
// chain, short enough that customers never get hours-old replies. Symmetric
// with AI_PENDING_MAX_AGE_MS on the inbound side.
const DEFAULT_OUTGOING_STALE_MAX_AGE_MS = 30 * 60 * 1000;

function outgoingStaleMaxAgeMs() {
  return parseInt(
    process.env.OUTGOING_STALE_JOB_MAX_AGE_MS || String(DEFAULT_OUTGOING_STALE_MAX_AGE_MS),
    10,
  );
}
```

Then replace the two inline reads:

Line 85 (`skipStaleOutgoingJob`):
```js
  const maxAgeMs = outgoingStaleMaxAgeMs();
```

Line 368 (`requeuePersistedOutgoingJobs`):
```js
  const maxAgeMs = outgoingStaleMaxAgeMs();
```

And add `outgoingStaleMaxAgeMs` to `module.exports` (the alphabetical list at line 504).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/outgoing-stale.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/outgoing-stale.test.js src/workers/outgoing-whatsapp-worker.js
git commit -m "fix(outgoing): raise silent reply expiry from 10 to 30 minutes (late beats lost)"
```

---

### Task 4: AI worker tuning — concurrency 2→4, lock 120s→180s (consistent everywhere)

**Why:** (a) Concurrency 2 means one slow conversation stalls every other customer behind it. (b) The 120s job lock is shorter than the worst-case AI retry chain (~150s: 30s timeout × 3 attempts + 429 backoff waits) — the lock can expire mid-retry and a second worker can double-process the same conversation. `message-queue.js:28` derives its stale-active threshold from the SAME env var (×2), so the default must change in both files together.

**Files:**
- Modify: `src/workers/ai-worker.js:33` (concurrency), `:910` (lock — extract to a named const), module.exports at `:985`
- Modify: `src/queues/message-queue.js:28` (default `120000` → `180000`)
- Test: `tests/ai-worker-tuning.test.js` (new)

**Regression safety:** Rate limiter (15 jobs/60s) is untouched and still the global throttle, so 4 concurrent jobs cannot stampede the AI provider. Postgres pool is shared and handles 4 concurrent jobs trivially. Stale-active cleanup threshold becomes 2×180s=360s — same semantics ("twice the lock"), just consistent with the new lock. Both knobs keep their env overrides (`AI_WORKER_CONCURRENCY`, `AI_WORKER_LOCK_DURATION_MS`).

- [ ] **Step 1: Write the failing test**

Create `tests/ai-worker-tuning.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// NOTE: these constants are read at require time. node --test runs each file
// in its own process, so no other test can have mutated the env first.
const { CONCURRENCY, LOCK_DURATION_MS } = require('../src/workers/ai-worker');

test('AI worker defaults: 4 concurrent conversations', () => {
  assert.equal(CONCURRENCY, 4);
});

test('AI worker lock outlives the worst-case AI retry chain (~150s)', () => {
  assert.equal(LOCK_DURATION_MS, 180000);
  assert.ok(LOCK_DURATION_MS > 150000, 'lock must be longer than 30s timeout × 3 attempts + backoff');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-worker-tuning.test.js`
Expected: FAIL — `CONCURRENCY` is `undefined` (not exported) / would be 2

- [ ] **Step 3: Implement**

In `src/workers/ai-worker.js` line 33, change and add:

```js
const CONCURRENCY = parseInt(process.env.AI_WORKER_CONCURRENCY || '4', 10);
```

Below `AI_REPLY_DEBOUNCE_MS` (line 38), add:

```js
// Must outlive the worst-case ai-client retry chain (30s timeout × 3 attempts
// + 429 backoff waits ≈ 150s). message-queue.js derives its stale-active
// cleanup threshold from the same env var (×2) — keep the defaults in sync.
const LOCK_DURATION_MS = parseInt(process.env.AI_WORKER_LOCK_DURATION_MS || '180000', 10);
```

In `createWorker()` (line 910), replace the inline parse:

```js
    lockDuration: LOCK_DURATION_MS,
```

In `module.exports` (line 985), add both:

```js
module.exports = {
  CONCURRENCY,
  LOCK_DURATION_MS,
  buildCombinedInboundText,
  ...
```

In `src/queues/message-queue.js` line 28:

```js
const STALE_ACTIVE_JOB_MS = parseInt(process.env.AI_WORKER_LOCK_DURATION_MS || '180000', 10) * 2;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-worker-tuning.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the AI-worker test neighborhood**

Run: `node --test tests/ai-worker-failure.test.js tests/ai-worker-quota.test.js tests/ai-worker-media-batching.test.js tests/ai-worker-store-assistant.test.js tests/hotfix-stuck-messages.test.js`
Expected: PASS — confirms the export-list change and constant extraction broke nothing

- [ ] **Step 6: Commit**

```bash
git add tests/ai-worker-tuning.test.js src/workers/ai-worker.js src/queues/message-queue.js
git commit -m "perf(ai-worker): concurrency 2->4, lock 120s->180s to outlive the retry chain"
```

---

### Task 5: Outgoing worker honors the owner pause (`escalated_until`)

**Why:** When the owner replies manually, `escalated_until` is set (ingest does this for phone replies, dashboard does it too) and the AI stops *generating* new replies — but a reply already sitting in the outgoing queue (humanization delay 50-75s) still fires AFTER the owner's message. This is the "البوت قاطعني مع العميلة" incident. The outgoing worker must cancel non-escalation replies for owner-paused conversations.

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js` (new helper + check in `processOutgoingWhatsapp` after the stopped-bot block at line 146; add to exports)
- Test: `tests/outgoing-owner-pause-cancel.test.js` (new)

**Regression safety:** Fail-open on every edge: DB not configured → send; query throws (e.g. `escalated_until` column missing on an old schema — same concern as `bot.controller.js:168-172`) → send; no conversation row → send; `escalated_until` in the past → send. Escalation notifications (`payload.escalation`) are exempt, mirroring `shouldCancelOutgoingForStoppedBot`. The reply row is marked `canceled` (an already-used status in this worker), so dashboards/health checks need no changes.

- [ ] **Step 1: Write the failing test**

Create `tests/outgoing-owner-pause-cancel.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConversationOwnerPaused } = require('../src/workers/outgoing-whatsapp-worker');

function fakeDb({ rows = [], throwErr = null, configured = true } = {}) {
  return {
    isConfigured: () => configured,
    query: async () => {
      if (throwErr) throw throwErr;
      return { rows };
    },
  };
}

test('paused: escalated_until in the future blocks the send', async () => {
  const database = fakeDb({ rows: [{ escalated_until: new Date(Date.now() + 60_000) }] });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', database }), true);
});

test('not paused: escalated_until in the past allows the send', async () => {
  const database = fakeDb({ rows: [{ escalated_until: new Date(Date.now() - 60_000) }] });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', database }), false);
});

test('fail-open: no row, null column, db error, db not configured', async () => {
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ rows: [] }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ rows: [{ escalated_until: null }] }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ throwErr: new Error('column does not exist') }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ configured: false }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: null, sender: 's', database: fakeDb({ rows: [] }) }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/outgoing-owner-pause-cancel.test.js`
Expected: FAIL with "isConversationOwnerPaused is not a function"

- [ ] **Step 3: Implement the helper + the cancel block**

In `src/workers/outgoing-whatsapp-worker.js`, add after `shouldCancelOutgoingForStoppedBot` (line 290):

```js
// The owner replying manually sets conversations.escalated_until (ingest for
// phone replies, dashboard for panel replies). The AI worker already refuses
// to GENERATE during the pause — but a reply queued before the owner stepped
// in (humanization delay 50-75s) would still fire after their message and
// "interrupt" the conversation. Cancel it here. Fail-open on every edge so a
// missing column / DB hiccup can never block customer replies.
async function isConversationOwnerPaused({ userId, sender, database = db }) {
  if (!userId || !sender || !database?.isConfigured?.()) return false;
  try {
    const result = await database.query(
      `SELECT escalated_until FROM conversations
       WHERE user_id = $1 AND sender = $2
       LIMIT 1`,
      [userId, sender],
    );
    const until = result.rows[0]?.escalated_until;
    return !!until && new Date(until).getTime() > Date.now();
  } catch (_) {
    return false;
  }
}
```

In `processOutgoingWhatsapp`, insert directly after the stopped-bot cancel block (after line 146, before `updateJobStatus(... 'processing')`):

```js
  if (!payload.escalation && await isConversationOwnerPaused({ userId, sender })) {
    const message = 'outgoing reply canceled because owner replied (escalated_until active)';
    await markReplyMessage(replyMessageId, 'canceled', {
      sentBy: WORKER_NAME,
      canceledAt: new Date().toISOString(),
      error: message,
    });
    await updateJobStatus(job.id, {
      status: 'canceled',
      finished_at: new Date(),
      attempts: job.attemptsMade,
      last_error: message,
    });
    return { skipped: true, reason: 'owner_paused' };
  }
```

Add `isConversationOwnerPaused` to `module.exports` (alphabetical list at line 504).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/outgoing-owner-pause-cancel.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the outgoing + escalation test neighborhood**

Run: `node --test tests/outgoing-worker-stop.test.js tests/outgoing-stale.test.js tests/escalated-until-mutes-bot.test.js tests/owner-pause.test.js tests/outgoing-worker-quota.test.js`
Expected: PASS — escalation sends remain exempt, AI-side mute semantics unchanged

- [ ] **Step 6: Commit**

```bash
git add tests/outgoing-owner-pause-cancel.test.js src/workers/outgoing-whatsapp-worker.js
git commit -m "fix(outgoing): cancel queued bot replies when the owner has taken over the conversation"
```

---

### Task 6: Faster stuck-message pickup (recovery loop 60s → 30s)

**Why:** A message that falls through the cracks (e.g. arrived while its conversation job was active) waits up to a full 60s before the recovery loop even notices it — on top of everything else. 30s halves that tail.

**Files:**
- Modify: `src/server.js:73`
- Test: none needed (single default-value change; the loop logic is covered by `tests/ai-recovery.test.js`)

**Regression safety:** The recovery query is a cheap indexed SELECT (`status='queued_for_ai'` bounded by age); doubling its frequency is negligible load. Duplicate-enqueue safety is unchanged — `reviveExistingAiJob` + the singleton `conversation-${id}` jobKey dedupe regardless of how often recovery runs. Env override `AI_RECOVERY_INTERVAL_MS` still wins.

- [ ] **Step 1: Change the default**

In `src/server.js` line 73:

```js
const AI_RECOVERY_INTERVAL_MS = parseInt(process.env.AI_RECOVERY_INTERVAL_MS || '30000', 10);
```

- [ ] **Step 2: Run the recovery tests**

Run: `node --test tests/ai-recovery.test.js tests/hotfix-stuck-messages.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "perf(recovery): halve stuck-message pickup latency (60s -> 30s loop)"
```

---

### Task 7: Full verification + ship

- [ ] **Step 1: Run the entire test suite**

Run: `node --test "tests/*.test.js"` (from repo root; on Windows PowerShell: `node --test tests/`)
Expected: ALL PASS, zero failures. If ANY test fails, stop and fix before proceeding — do not rationalize a failure as "pre-existing" without running it on the base branch first to prove it.

- [ ] **Step 2: Eyeball the full diff**

Run: `git diff master...HEAD --stat` then `git diff master...HEAD`
Checklist:
- Only the 6 intended files + 4 test files touched
- No accidental whitespace/comment churn elsewhere
- Every new default has an env-var escape hatch

- [ ] **Step 3: Push branch + open PR (squash-merge convention, base `master`)**

```bash
git push -u origin HEAD
gh pr create --base master --title "fix(pipeline): kill the 10-minute reply delays and silent reply loss" --body "<summary of the 6 fixes, root causes, env escape hatches, test evidence>"
```

- [ ] **Step 4: Post-deploy verification plan (manual, production)**

After Railway deploys:
1. Dashboard health check (`POST /api/health-check`) — all 7 green, stuck count = 0.
2. Send a test message → reply arrives within the configured humanization window (50-75s default).
3. Reply manually to a test conversation from the phone while a bot reply is queued → bot reply must get canceled (check `messages.status='canceled'` with `owner_paused` note in logs).
4. Railway logs: `grep "canceled because owner replied"` and confirm no `socket_not_open` storm (occasional ones are the guard working).

---

## Production env recommendations (no code — apply in Railway after merge)

These are NOT part of the PR; they are knobs the owner can choose:

| Env var | Current effective | Suggested | Effect |
|---|---|---|---|
| (dashboard) سرعة الرد | `1min` (50-75s) | `instant`/`30s` (22-40s) | biggest perceived-latency win, zero risk |
| `AI_REPLY_DEBOUNCE_MS` | 9000 | 4000 | replies start 5s sooner; rapid multi-messages batch slightly less |

