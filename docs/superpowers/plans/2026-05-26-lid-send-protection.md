# @lid Send Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the outgoing WhatsApp worker from crashing or silently failing when it tries to send a reply to a `@lid` JID (a WhatsApp internal identifier used when the phone number is unknown). Instead, mark the message as `skipped_lid` and log a clear warning.

**Architecture:** In `processOutgoingWhatsapp()` in `src/workers/outgoing-whatsapp-worker.js`, add an early guard after the payload is parsed. If `sender.endsWith('@lid')`, skip sending, update the message status to `'skipped_lid'`, and return without error so BullMQ marks the job as completed (not failed/retried).

**Tech Stack:** Node.js, `node:test`, `node:assert/strict`. Tests use stub-only mocks (no real WhatsApp, no real DB).

---

### Task 1: @lid guard in outgoing worker

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js` (function `processOutgoingWhatsapp`, lines 84-148)
- Create: `tests/outgoing-worker-lid-guard.test.js`

**Context:**

`processOutgoingWhatsapp(job, { getUserBot })` (line 84) starts by extracting `userId`, `sender`, `reply`, `replyMessageId` from `job.data`. The `sender` for `@lid` contacts will look like `278571713060916@lid`.

The fix is to insert this block right after the existing validation checks (after the `if (!reply)` guard at line 94), before `skipStaleOutgoingJob`:

```js
if (sender.endsWith('@lid')) {
  // WhatsApp hides the phone number for this contact — cannot send
  await markReplyMessage(replyMessageId, 'skipped_lid', {
    sentBy: WORKER_NAME,
    skippedAt: new Date().toISOString(),
    reason: 'sender_is_lid_only',
  });
  console.warn(`${new Date().toISOString()} [${WORKER_NAME}] skipped @lid sender ${sender}`);
  return { skipped: true, reason: 'sender_is_lid_only' };
}
```

`markReplyMessage` is already defined in the same file (line 33) and accepts `(replyMessageId, status, rawPayload)`.

- [ ] **Step 1: Write the failing test**

Create `tests/outgoing-worker-lid-guard.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We need to test processOutgoingWhatsapp without importing the real worker
// (which would try to connect to Redis). So we require only the module and
// check that @lid jobs return early without calling getUserBot.

const {
  processOutgoingWhatsapp,
} = require('../src/workers/outgoing-whatsapp-worker');

function makeJob(data = {}) {
  return {
    id: 'job-1',
    data: {
      userId: 'user-1',
      sender: '278571713060916@lid',
      reply: 'مرحبا',
      replyMessageId: 'msg-1',
      ...data,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

function makeDb() {
  const updates = [];
  return {
    updates,
    isConfigured: () => true,
    query: async (sql, params) => {
      updates.push({ sql: sql.trim(), params });
      return { rows: [] };
    },
  };
}

test('processOutgoingWhatsapp skips @lid sender without calling getUserBot', async (t) => {
  // Patch the module-level db used by markReplyMessage
  // We intercept by passing a mock getUserBot that throws if called
  const getUserBot = t.mock.fn(() => {
    throw new Error('getUserBot must not be called for @lid sender');
  });

  const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'sender_is_lid_only');
  assert.equal(getUserBot.mock.calls.length, 0, 'getUserBot must NOT be called');
});

test('processOutgoingWhatsapp does NOT skip normal @s.whatsapp.net sender', async (t) => {
  let getUserBotCalled = false;
  const getUserBot = () => {
    getUserBotCalled = true;
    // Throw to stop execution early — we only care that we got past the @lid check
    throw new Error('intentional stop after @lid guard passed');
  };

  try {
    await processOutgoingWhatsapp(makeJob({ sender: '966501234567@s.whatsapp.net' }), { getUserBot });
  } catch (err) {
    // Expected — we threw from getUserBot on purpose
    assert.match(err.message, /intentional stop/);
  }

  assert.equal(getUserBotCalled, true, 'getUserBot must be called for normal sender');
});

test('processOutgoingWhatsapp skips @c.us sender that looks like lid — only real lid test', async (t) => {
  // Only @lid suffix should be guarded; @c.us is a normal phone-based JID
  let getUserBotCalled = false;
  const getUserBot = () => {
    getUserBotCalled = true;
    throw new Error('intentional stop');
  };

  try {
    await processOutgoingWhatsapp(makeJob({ sender: '966501234567@c.us' }), { getUserBot });
  } catch (err) {
    assert.match(err.message, /intentional stop/);
  }
  assert.equal(getUserBotCalled, true, '@c.us must NOT be treated as @lid');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/outgoing-worker-lid-guard.test.js
```
Expected: `skips @lid sender` FAILS (no guard exists yet, so `getUserBot` is called and throws).

- [ ] **Step 3: Add the guard to processOutgoingWhatsapp**

In `src/workers/outgoing-whatsapp-worker.js`, find `processOutgoingWhatsapp` (line 84). After the existing validation block that ends with `if (!reply) throw new Error(...)` (around line 94), insert the @lid guard before `skipStaleOutgoingJob`:

```js
  // Guard: @lid JIDs have no phone number — Baileys cannot send to them
  if (sender.endsWith('@lid')) {
    await markReplyMessage(replyMessageId, 'skipped_lid', {
      sentBy: WORKER_NAME,
      skippedAt: new Date().toISOString(),
      reason: 'sender_is_lid_only',
    });
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] skipped @lid sender ${sender}`);
    return { skipped: true, reason: 'sender_is_lid_only' };
  }
```

No other changes to the file.

- [ ] **Step 4: Run tests to verify they pass**

```
node --test tests/outgoing-worker-lid-guard.test.js
```
Expected: 3/3 PASS.

- [ ] **Step 5: Run full test suite**

```
node --test tests/
```
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/workers/outgoing-whatsapp-worker.js tests/outgoing-worker-lid-guard.test.js
git commit -m "feat(worker): skip outgoing messages to @lid-only contacts gracefully"
```
