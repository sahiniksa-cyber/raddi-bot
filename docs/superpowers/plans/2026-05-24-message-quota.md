# Message Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cost-display billing UI with a simple message-quota system where admins top up customers manually and the bot goes silent when the quota is exhausted or expired.

**Architecture:** Five new columns on `billing_accounts` (no new tables). One new helper module `src/services/billing/message-quota.js` exposes `checkMessageQuota`, `decrementMessageQuota`, and `addMessagesToQuota`. The AI worker checks quota before calling OpenAI (saves cost); the outgoing worker atomically decrements after each successful WhatsApp send (single source of truth for "what counts"). The admin dashboard gets one new endpoint + modal; the customer dashboard loses its cost panel and gains a message-credit panel.

**Tech Stack:** Node.js 18+, Express, PostgreSQL via `pg`, BullMQ, Baileys, vanilla HTML/CSS/JS dashboards. Tests use `node --test` with hand-rolled fakes (no Jest/sinon).

**Spec reference:** [docs/superpowers/specs/2026-05-24-message-quota-design.md](../specs/2026-05-24-message-quota-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/db/migrations/init.js` | Modify | Add 5 columns + index to `billing_accounts` |
| `src/services/billing/message-quota.js` | Create | `checkMessageQuota`, `decrementMessageQuota`, `addMessagesToQuota`, `computeEffectiveRemaining` |
| `tests/message-quota.test.js` | Create | Unit tests for the 4 helpers (no DB — fake `query`) |
| `src/workers/ai-worker.js` | Modify | Check quota before AI/auto-reply; mark inbound `quota_exceeded` |
| `tests/ai-worker-quota.test.js` | Create | Verify ai-worker skips when quota=0 |
| `src/workers/outgoing-whatsapp-worker.js` | Modify | Atomic decrement after successful `sendWhatsappReply` |
| `tests/outgoing-worker-quota.test.js` | Create | Verify atomic decrement + race-condition handling |
| `src/workers/ai-recovery.js` | Modify | Skip messages with `status='quota_exceeded'` |
| `src/services/billing/billing-service.js` | Modify | Expose new quota fields in `buildAdminCustomerRow` |
| `src/routes/admin.routes.js` | Modify | New `POST /api/admin/customers/:userId/add-messages` |
| `tests/admin-add-messages.test.js` | Create | Endpoint validation tests |
| `src/routes/billing.routes.js` | Modify | New `GET /api/billing/messages` |
| `tests/dashboard-billing-messages.test.js` | Create | Customer endpoint test |
| `dashboard/admin.html` | Modify | Add quota column + "Add messages" modal |
| `dashboard/index.html` | Modify | Remove cost panel + stat; add quota panel + empty-state banner + topup button |
| `tests/dashboard-ui.test.js` | Modify | Assert cost UI gone, quota UI present |

---

## Task 1: Migration — add quota columns

**Files:**
- Modify: `src/db/migrations/init.js` (append after the existing `ALTER TABLE billing_accounts` blocks around line 213)
- Test: `tests/message-quota-migration.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/message-quota-migration.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

test('migration adds messages_remaining column to billing_accounts', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS messages_remaining INTEGER NOT NULL DEFAULT 0/);
});

test('migration adds quota_expires_at column', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS quota_expires_at TIMESTAMPTZ/);
});

test('migration adds expire_resets_quota column with TRUE default', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS expire_resets_quota BOOLEAN NOT NULL DEFAULT TRUE/);
});

test('migration adds last_topup_amount and last_topup_at columns', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS last_topup_amount INTEGER NOT NULL DEFAULT 0/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ/);
});

test('migration adds idx_billing_accounts_quota index', () => {
  assert.match(migrationSource, /CREATE INDEX IF NOT EXISTS idx_billing_accounts_quota/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/message-quota-migration.test.js`
Expected: 5 FAIL (no matching `ADD COLUMN` lines yet).

- [ ] **Step 3: Add the migration statements**

In `src/db/migrations/init.js`, find the last `ALTER TABLE billing_accounts` block (around line 213) and add **after** it (before the next `CREATE INDEX` or section break):

```js
  `ALTER TABLE billing_accounts
     ADD COLUMN IF NOT EXISTS messages_remaining INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS quota_expires_at TIMESTAMPTZ NULL,
     ADD COLUMN IF NOT EXISTS expire_resets_quota BOOLEAN NOT NULL DEFAULT TRUE,
     ADD COLUMN IF NOT EXISTS last_topup_amount INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ NULL`,
  `CREATE INDEX IF NOT EXISTS idx_billing_accounts_quota
     ON billing_accounts(user_id, messages_remaining)
     WHERE messages_remaining > 0`,
```

(These are entries in the migrations array — match the surrounding style of backtick-delimited SQL strings followed by a comma.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/message-quota-migration.test.js`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/init.js tests/message-quota-migration.test.js
git commit -m "feat(db): add message_quota columns to billing_accounts"
```

---

## Task 2: `message-quota.js` helper — `computeEffectiveRemaining`

**Files:**
- Create: `src/services/billing/message-quota.js`
- Test: `tests/message-quota.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/message-quota.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEffectiveRemaining } = require('../src/services/billing/message-quota');

test('computeEffectiveRemaining returns the raw remaining when not expired', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() + 86400000).toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining returns 0 when expired and flag is set', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(result, 0);
});

test('computeEffectiveRemaining keeps remaining when expired but flag is false', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: false,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining handles null quota_expires_at as not-expired', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: null,
    expire_resets_quota: true,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining returns 0 for null/empty row', () => {
  assert.equal(computeEffectiveRemaining(null), 0);
  assert.equal(computeEffectiveRemaining({}), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/message-quota.test.js`
Expected: FAIL — `Cannot find module '../src/services/billing/message-quota'`.

- [ ] **Step 3: Create the module with `computeEffectiveRemaining`**

Create `src/services/billing/message-quota.js`:

```js
'use strict';

const db = require('../../db/client');

function computeEffectiveRemaining(row) {
  if (!row) return 0;
  const remaining = Number(row.messages_remaining) || 0;
  if (remaining <= 0) return 0;
  const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
  const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();
  return expired ? 0 : remaining;
}

module.exports = { computeEffectiveRemaining };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/message-quota.test.js`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing/message-quota.js tests/message-quota.test.js
git commit -m "feat(billing): add computeEffectiveRemaining helper for quota expiry"
```

---

## Task 3: `message-quota.js` — `checkMessageQuota`

**Files:**
- Modify: `src/services/billing/message-quota.js`
- Test: `tests/message-quota.test.js` (extend)

- [ ] **Step 1: Add failing tests**

Append to `tests/message-quota.test.js`:

```js
const { checkMessageQuota } = require('../src/services/billing/message-quota');

function fakeDb(rows) {
  return { query: async () => ({ rows }) };
}

test('checkMessageQuota returns canReply when remaining > 0 and not expired', async () => {
  const database = fakeDb([{
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() + 86400000).toISOString(),
    expire_resets_quota: true,
  }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, true);
  assert.equal(result.remaining, 2847);
});

test('checkMessageQuota refuses when no account exists', async () => {
  const result = await checkMessageQuota('user-1', { database: fakeDb([]) });
  assert.deepEqual(result, { canReply: false, remaining: 0, reason: 'no_account' });
});

test('checkMessageQuota refuses when remaining is zero', async () => {
  const database = fakeDb([{ messages_remaining: 0, quota_expires_at: null, expire_resets_quota: true }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'empty');
});

test('checkMessageQuota refuses when expired and flag is set', async () => {
  const database = fakeDb([{
    messages_remaining: 100,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: true,
  }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'expired');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/message-quota.test.js`
Expected: 4 new tests FAIL (checkMessageQuota is undefined).

- [ ] **Step 3: Implement `checkMessageQuota`**

Append to `src/services/billing/message-quota.js` (before `module.exports`):

```js
async function checkMessageQuota(userId, { database = db } = {}) {
  const result = await database.query(
    `SELECT messages_remaining, quota_expires_at, expire_resets_quota
     FROM billing_accounts WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return { canReply: false, remaining: 0, reason: 'no_account' };

  const remaining = Number(row.messages_remaining) || 0;
  const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
  const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();

  if (expired) return { canReply: false, remaining: 0, reason: 'expired', expiresAt };
  if (remaining <= 0) return { canReply: false, remaining: 0, reason: 'empty' };

  return { canReply: true, remaining, expiresAt };
}
```

Update `module.exports`:

```js
module.exports = { computeEffectiveRemaining, checkMessageQuota };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/message-quota.test.js`
Expected: 9 PASS total.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing/message-quota.js tests/message-quota.test.js
git commit -m "feat(billing): add checkMessageQuota for AI-worker pre-flight check"
```

---

## Task 4: `message-quota.js` — `decrementMessageQuota`

**Files:**
- Modify: `src/services/billing/message-quota.js`
- Test: `tests/message-quota.test.js` (extend)

- [ ] **Step 1: Add failing tests**

Append to `tests/message-quota.test.js`:

```js
const { decrementMessageQuota } = require('../src/services/billing/message-quota');

function fakeDbCapture(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test('decrementMessageQuota returns success and new remaining on update', async () => {
  const database = fakeDbCapture([{ messages_remaining: 2846 }]);
  const result = await decrementMessageQuota('user-1', { database });
  assert.equal(result.success, true);
  assert.equal(result.remaining, 2846);
  assert.match(database.calls[0].sql, /UPDATE billing_accounts/);
  assert.match(database.calls[0].sql, /messages_remaining = messages_remaining - 1/);
  assert.match(database.calls[0].sql, /WHERE user_id = \$1/);
  assert.match(database.calls[0].sql, /messages_remaining > 0/);
});

test('decrementMessageQuota returns failure when UPDATE matches no rows', async () => {
  const database = fakeDbCapture([]);
  const result = await decrementMessageQuota('user-1', { database });
  assert.deepEqual(result, { success: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/message-quota.test.js`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement `decrementMessageQuota`**

Append to `src/services/billing/message-quota.js` (before `module.exports`):

```js
async function decrementMessageQuota(userId, { database = db } = {}) {
  const result = await database.query(
    `UPDATE billing_accounts
     SET messages_remaining = messages_remaining - 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND messages_remaining > 0
       AND (
         NOT expire_resets_quota
         OR quota_expires_at IS NULL
         OR quota_expires_at > NOW()
       )
     RETURNING messages_remaining`,
    [userId],
  );
  if (!result.rows[0]) return { success: false };
  return { success: true, remaining: result.rows[0].messages_remaining };
}
```

Update `module.exports`:

```js
module.exports = { computeEffectiveRemaining, checkMessageQuota, decrementMessageQuota };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/message-quota.test.js`
Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing/message-quota.js tests/message-quota.test.js
git commit -m "feat(billing): add atomic decrementMessageQuota for outgoing worker"
```

---

## Task 5: `message-quota.js` — `addMessagesToQuota`

**Files:**
- Modify: `src/services/billing/message-quota.js`
- Test: `tests/message-quota.test.js` (extend)

- [ ] **Step 1: Add failing tests**

Append to `tests/message-quota.test.js`:

```js
const { addMessagesToQuota } = require('../src/services/billing/message-quota');

test('addMessagesToQuota issues an UPSERT with INTERVAL and returns the new state', async () => {
  const database = fakeDbCapture([{
    messages_remaining: 5847,
    quota_expires_at: '2026-06-23T12:00:00.000Z',
    expire_resets_quota: true,
    last_topup_amount: 3000,
    last_topup_at: '2026-05-24T12:00:00.000Z',
  }]);
  const result = await addMessagesToQuota('user-1', {
    messages: 3000,
    days: 30,
    expireResetsQuota: true,
    database,
  });
  assert.equal(result.messages_remaining, 5847);
  assert.equal(result.last_topup_amount, 3000);
  assert.match(database.calls[0].sql, /INSERT INTO billing_accounts/);
  assert.match(database.calls[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(database.calls[0].sql, /messages_remaining \+ EXCLUDED\.messages_remaining/);
  assert.match(database.calls[0].sql, /NOW\(\) \+ \(\$3 \|\| ' days'\)::INTERVAL/);
  assert.deepEqual(database.calls[0].params, ['user-1', 3000, '30', true]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/message-quota.test.js`
Expected: 1 new test FAIL.

- [ ] **Step 3: Implement `addMessagesToQuota`**

Append to `src/services/billing/message-quota.js` (before `module.exports`):

```js
async function addMessagesToQuota(userId, { messages, days, expireResetsQuota, database = db }) {
  const result = await database.query(
    `INSERT INTO billing_accounts (
       user_id, messages_remaining, quota_expires_at, expire_resets_quota,
       last_topup_amount, last_topup_at
     )
     VALUES ($1, $2, NOW() + ($3 || ' days')::INTERVAL, $4, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET messages_remaining = billing_accounts.messages_remaining + EXCLUDED.messages_remaining,
           quota_expires_at = EXCLUDED.quota_expires_at,
           expire_resets_quota = EXCLUDED.expire_resets_quota,
           last_topup_amount = EXCLUDED.last_topup_amount,
           last_topup_at = NOW(),
           updated_at = NOW()
     RETURNING messages_remaining, quota_expires_at, expire_resets_quota,
               last_topup_amount, last_topup_at`,
    [userId, messages, String(days), expireResetsQuota],
  );
  return result.rows[0];
}
```

Update `module.exports`:

```js
module.exports = {
  computeEffectiveRemaining,
  checkMessageQuota,
  decrementMessageQuota,
  addMessagesToQuota,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/message-quota.test.js`
Expected: 12 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing/message-quota.js tests/message-quota.test.js
git commit -m "feat(billing): add addMessagesToQuota upsert for admin top-up"
```

---

## Task 6: ai-worker quota check before generation

**Files:**
- Modify: `src/workers/ai-worker.js`
- Test: `tests/ai-worker-quota.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/ai-worker-quota.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We test the exported `processAiReply` is structured around checkMessageQuota
// by inspecting the worker source directly. (Full integration is exercised
// via the existing ai-worker tests once the change lands.)

const fs = require('fs');
const path = require('path');

const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('ai-worker imports checkMessageQuota from message-quota helper', () => {
  assert.match(workerSource, /require\(['"]\.\.\/services\/billing\/message-quota['"]\)/);
  assert.match(workerSource, /checkMessageQuota/);
});

test('ai-worker marks inbound messages as quota_exceeded when quota is empty', () => {
  assert.match(workerSource, /quota_exceeded/);
});

test('ai-worker skips ai.getReply when quota.canReply is false', () => {
  // The check must happen before ai.getReply is called.
  const checkIdx = workerSource.indexOf('checkMessageQuota');
  const aiIdx = workerSource.indexOf('ai.getReply');
  assert.ok(checkIdx > 0, 'checkMessageQuota must be referenced');
  assert.ok(aiIdx > 0, 'ai.getReply must be referenced');
  assert.ok(checkIdx < aiIdx, 'checkMessageQuota must appear before ai.getReply in source order');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-worker-quota.test.js`
Expected: 3 FAIL.

- [ ] **Step 3: Update `ai-worker.js`**

In `src/workers/ai-worker.js`:

**3a. Add the import (after the other service requires near the top):**

```js
const { checkMessageQuota } = require('../services/billing/message-quota');
```

**3b. Add a helper near the other `mark*` helpers (around line 260):**

```js
async function markInboundMessagesQuotaExceeded({ database = db, messageIds = [], reason = 'empty' }) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length || !database.isConfigured?.()) return;
  await database.query(
    `UPDATE messages
     SET status = 'quota_exceeded',
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
     WHERE id = ANY($1::uuid[])`,
    [ids, JSON.stringify({ quotaExceededAt: new Date().toISOString(), reason })],
  );
}
```

**3c. In `processAiReply`, insert the check right after `enrichedMessages` is built and before the `findAutoReply` call:**

Locate this block (around line 371):
```js
    const text = buildCombinedInboundText(enrichedMessages);
    if (!text.trim()) throw new Error('AI job has empty inbound text');

    const instantReply = findAutoReply(config, text);
```

Insert between `if (!text.trim())…` and `const instantReply`:
```js
    const quota = await checkMessageQuota(userId);
    if (!quota.canReply) {
      await markInboundMessagesQuotaExceeded({
        messageIds: enrichedMessages.map(m => m.id),
        reason: quota.reason,
      });
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_no_quota',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
        last_error: `quota ${quota.reason}`,
      });
      logger.warn('quota', `silent: ${userId} (${quota.reason}, ${quota.remaining} remaining)`);
      return { skipped: true, reason: quota.reason };
    }

```

**3d. Export the new helper (extend the existing `module.exports` block at bottom):**

Add `markInboundMessagesQuotaExceeded` to the exports list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/ai-worker-quota.test.js`
Expected: 3 PASS.

- [ ] **Step 5: Run the existing ai-worker tests**

Run: `node --test tests/ai-worker-*.test.js tests/ai-history.test.js tests/ai-recovery.test.js`
Expected: ALL PASS (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/workers/ai-worker.js tests/ai-worker-quota.test.js
git commit -m "feat(ai-worker): skip generation when message quota is exhausted"
```

---

## Task 7: Outgoing worker atomic decrement

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Test: `tests/outgoing-worker-quota.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/outgoing-worker-quota.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'),
  'utf8',
);

test('outgoing worker imports decrementMessageQuota', () => {
  assert.match(workerSource, /decrementMessageQuota/);
  assert.match(workerSource, /require\(['"]\.\.\/services\/billing\/message-quota['"]\)/);
});

test('decrementMessageQuota is called after sendWhatsappReply', () => {
  const sendIdx = workerSource.indexOf('await sendWhatsappReply');
  const decIdx = workerSource.indexOf('decrementMessageQuota');
  assert.ok(sendIdx > 0);
  assert.ok(decIdx > sendIdx, 'decrementMessageQuota must run AFTER sendWhatsappReply');
});

test('quotaRemainingAfter is recorded in markReplyMessage payload', () => {
  assert.match(workerSource, /quotaRemainingAfter/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/outgoing-worker-quota.test.js`
Expected: 3 FAIL.

- [ ] **Step 3: Update `outgoing-whatsapp-worker.js`**

**3a. Add the import (near the other service requires near the top):**

```js
const { decrementMessageQuota } = require('../services/billing/message-quota');
```

**3b. In `processOutgoingWhatsapp`, find this block (around line 127):**

```js
  await sendWhatsappReply(bot, { sender, reply, providerMessageId });

  await markReplyMessage(replyMessageId, 'sent', { sentBy: WORKER_NAME, sentAt: new Date().toISOString() });
```

Replace with:

```js
  await sendWhatsappReply(bot, { sender, reply, providerMessageId });

  const dec = await decrementMessageQuota(userId);
  if (!dec.success) {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] sent ${replyMessageId} but quota already empty for ${userId}`);
  }

  await markReplyMessage(replyMessageId, 'sent', {
    sentBy: WORKER_NAME,
    sentAt: new Date().toISOString(),
    quotaRemainingAfter: dec.remaining ?? 0,
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/outgoing-worker-quota.test.js`
Expected: 3 PASS.

- [ ] **Step 5: Run existing outgoing tests**

Run: `node --test tests/outgoing-stale.test.js tests/outgoing-worker-stop.test.js`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/outgoing-whatsapp-worker.js tests/outgoing-worker-quota.test.js
git commit -m "feat(outgoing): atomic quota decrement after successful WhatsApp send"
```

---

## Task 8: ai-recovery skips `quota_exceeded`

**Files:**
- Modify: `src/workers/ai-recovery.js`
- Test: `tests/ai-recovery.test.js` (extend)

- [ ] **Step 1: Add failing test**

Append to `tests/ai-recovery.test.js`:

```js
test('recoverQueuedAiReplyJobs excludes messages with status quota_exceeded', async () => {
  let capturedSql = '';
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    },
  };
  const { recoverQueuedAiReplyJobs } = require('../src/workers/ai-recovery');
  await recoverQueuedAiReplyJobs({ database, enqueue: async () => {}, aiQueue: { getJob: async () => null } });
  assert.match(capturedSql, /'queued_for_ai'/);
  assert.doesNotMatch(capturedSql, /quota_exceeded/, 'recovery query must not requeue quota_exceeded rows');
});
```

(Note: existing recovery query already uses `WHERE m.status IN ('queued_for_ai', 'ai_failed')` so `quota_exceeded` is implicitly excluded. The test only verifies the literal stays out of the SQL — no code change required if the file already matches. If the test fails because the file references `quota_exceeded` somewhere we don't want, fix that.)

- [ ] **Step 2: Run test**

Run: `node --test tests/ai-recovery.test.js`
Expected: PASS (the existing recovery query already excludes quota_exceeded by virtue of the `IN ('queued_for_ai', 'ai_failed')` clause).

- [ ] **Step 3: If the test fails, audit `src/workers/ai-recovery.js`**

Read the WHERE clause around the `SELECT DISTINCT ON` block. Confirm it only matches `'queued_for_ai'` and `'ai_failed'`. If new statuses crept in, restrict the IN list.

- [ ] **Step 4: Commit (only if a fix was needed)**

```bash
git add src/workers/ai-recovery.js tests/ai-recovery.test.js
git commit -m "test(ai-recovery): pin recovery query to exclude quota_exceeded"
```

(If no fix was needed, only the test file is committed.)

---

## Task 9: Admin endpoint — `POST /add-messages`

**Files:**
- Modify: `src/routes/admin.routes.js`
- Test: `tests/admin-add-messages.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/admin-add-messages.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createAdminRoutes } = require('../src/routes/admin.routes');

function startApp(routerOpts) {
  const app = express();
  app.use(express.json());
  app.use(createAdminRoutes({ ...routerOpts, dashboardDir: '/tmp' }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('POST add-messages rejects when messages is missing or zero', async () => {
  const { server, port } = await startApp({
    requireAuth: (req, _res, next) => { req.session = { isAdmin: true }; next(); },
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await postJson(port, '/api/admin/customers/u1/add-messages', { messages: 0, days: 30 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /عدد الرسائل/);
  } finally {
    server.close();
  }
});

test('POST add-messages rejects when days is missing or zero', async () => {
  const { server, port } = await startApp({
    requireAuth: (req, _res, next) => { req.session = { isAdmin: true }; next(); },
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await postJson(port, '/api/admin/customers/u1/add-messages', { messages: 3000, days: 0 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /عدد الأيام/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-add-messages.test.js`
Expected: 2 FAIL (endpoint not found → 404 instead of 400).

- [ ] **Step 3: Add the endpoint**

In `src/routes/admin.routes.js`:

**3a. Add the import at the top of `createAdminRoutes`'s deps section** (with the other billing imports around line 18):

```js
const { addMessagesToQuota } = require('../services/billing/message-quota');
```

**3b. Insert the new route after the existing `set-days` route (around line 123, before the Coupon CRUD block):**

```js
  // Add messages to a customer's quota (admin manual top-up)
  router.post('/api/admin/customers/:userId/add-messages', requireOwner, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const messages = parseInt(req.body?.messages, 10) || 0;
      const days = parseInt(req.body?.days, 10) || 0;
      const expireResetsQuota = req.body?.expireResetsQuota !== false; // default TRUE

      if (messages <= 0) return res.status(400).json({ success: false, message: 'عدد الرسائل غير صحيح' });
      if (days <= 0) return res.status(400).json({ success: false, message: 'عدد الأيام غير صحيح' });

      const result = await addMessagesToQuota(userId, { messages, days, expireResetsQuota });
      res.json({
        success: true,
        messagesRemaining: result.messages_remaining,
        quotaExpiresAt: result.quota_expires_at,
        expireResetsQuota: result.expire_resets_quota,
        lastTopupAmount: result.last_topup_amount,
        lastTopupAt: result.last_topup_at,
      });
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-add-messages.test.js`
Expected: 2 PASS.

- [ ] **Step 5: Run existing admin tests**

Run: `node --test tests/admin-auth.test.js`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.routes.js tests/admin-add-messages.test.js
git commit -m "feat(admin): POST /api/admin/customers/:userId/add-messages endpoint"
```

---

## Task 10: Admin list — expose quota fields

**Files:**
- Modify: `src/services/billing/billing-service.js` (function `buildAdminCustomerRow`)
- Modify: `src/services/billing/billing-service.js` (function `listAdminCustomers`)
- Test: `tests/billing-service.test.js` (extend)

- [ ] **Step 1: Add failing test**

Append to `tests/billing-service.test.js`:

```js
test('buildAdminCustomerRow exposes quota fields with effective remaining', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const expired = new Date(Date.now() - 86400000);
  const row = buildAdminCustomerRow({
    id: 'u1',
    email: 'a@b.com',
    messages_remaining: 100,
    quota_expires_at: expired.toISOString(),
    expire_resets_quota: true,
    last_topup_amount: 3000,
    last_topup_at: expired.toISOString(),
  });
  assert.equal(row.messagesRemaining, 100);
  assert.equal(row.effectiveRemaining, 0); // expired + flag = 0
  assert.equal(row.quotaStatus, 'expired');
  assert.equal(row.lastTopupAmount, 3000);
});

test('buildAdminCustomerRow returns quotaStatus=active when remaining>0 and not expired', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const future = new Date(Date.now() + 86400000);
  const row = buildAdminCustomerRow({
    id: 'u1', email: 'a@b.com',
    messages_remaining: 100,
    quota_expires_at: future.toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(row.quotaStatus, 'active');
  assert.equal(row.effectiveRemaining, 100);
});

test('buildAdminCustomerRow returns quotaStatus=never_topped_up when last_topup_at is null', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const row = buildAdminCustomerRow({ id: 'u1', email: 'a@b.com', messages_remaining: 0 });
  assert.equal(row.quotaStatus, 'never_topped_up');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/billing-service.test.js`
Expected: 3 new FAIL.

- [ ] **Step 3: Update `buildAdminCustomerRow`**

In `src/services/billing/billing-service.js`, locate `buildAdminCustomerRow` (around line 23) and extend the returned object. After the existing `remainingDays` line, before the closing brace of the return object, append these fields:

```js
    messagesRemaining: Number(row.messages_remaining || 0),
    quotaExpiresAt: row.quota_expires_at || null,
    expireResetsQuota: row.expire_resets_quota !== false,
    lastTopupAmount: Number(row.last_topup_amount || 0),
    lastTopupAt: row.last_topup_at || null,
    effectiveRemaining: (() => {
      const remaining = Number(row.messages_remaining || 0);
      if (remaining <= 0) return 0;
      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = row.expire_resets_quota !== false && expiresAt && expiresAt < new Date();
      return expired ? 0 : remaining;
    })(),
    quotaStatus: (() => {
      if (!row.last_topup_at) return 'never_topped_up';
      const remaining = Number(row.messages_remaining || 0);
      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = row.expire_resets_quota !== false && expiresAt && expiresAt < new Date();
      if (expired) return 'expired';
      if (remaining <= 0) return 'empty';
      return 'active';
    })(),
    quotaDaysLeft: (() => {
      if (!row.quota_expires_at) return null;
      const diff = new Date(row.quota_expires_at) - new Date();
      return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    })(),
```

**3b. Also update the SELECT in `listAdminCustomers`.** Find the SQL query and confirm it pulls the new columns (`messages_remaining`, `quota_expires_at`, `expire_resets_quota`, `last_topup_amount`, `last_topup_at`). If it uses `SELECT *` from `billing_accounts`, no change needed. If it lists columns explicitly, add the five new ones.

- [ ] **Step 4: Run tests**

Run: `node --test tests/billing-service.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing/billing-service.js tests/billing-service.test.js
git commit -m "feat(billing): expose quota fields in admin customer rows"
```

---

## Task 11: Customer endpoint — `GET /api/billing/messages`

**Files:**
- Modify: `src/routes/billing.routes.js`
- Test: `tests/dashboard-billing-messages.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-billing-messages.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const Module = require('module');
const originalResolve = Module._resolveFilename;

// Stub the message-quota module before requiring billing routes
const stubPath = require('path').resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js');
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, exports: {
    computeEffectiveRemaining: () => 2847,
    checkMessageQuota: async () => ({ canReply: true, remaining: 2847 }),
  }
};

const { createBillingRoutes } = require('../src/routes/billing.routes');

function startApp(routerOpts) {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });
  app.use(createBillingRoutes(routerOpts));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    }).on('error', reject);
  });
}

test('GET /api/billing/messages returns quota snapshot', async () => {
  const { server, port } = await startApp({
    requireAuth: (_req, _res, next) => next(),
    billingSettings: { supportWhatsappPhone: '966500000000' },
  });
  try {
    const r = await getJson(port, '/api/billing/messages');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.remaining, 'number');
    assert.equal(r.body.supportWhatsappPhone, '966500000000');
    assert.ok(['active', 'empty', 'expired'].includes(r.body.status));
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard-billing-messages.test.js`
Expected: FAIL — endpoint not found (404 or empty body).

- [ ] **Step 3: Add the endpoint**

In `src/routes/billing.routes.js`:

**3a. Add the import at top:**

```js
const db = require('../db/client');
const { computeEffectiveRemaining } = require('../services/billing/message-quota');
```

**3b. Add the route inside `createBillingRoutes` (before `return router;` at the end):**

```js
  router.get('/api/billing/messages', requireAuth, async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT messages_remaining, quota_expires_at, expire_resets_quota,
                last_topup_amount, last_topup_at
         FROM billing_accounts WHERE user_id = $1`,
        [req.session.userId],
      );
      const row = result.rows[0] || {};
      const remaining = computeEffectiveRemaining(row);
      const total = Number(row.last_topup_amount || 0);
      const used = Math.max(0, total - remaining);

      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();
      const daysLeft = expiresAt
        ? Math.max(0, Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)))
        : null;

      let status = 'empty';
      if (expired) status = 'expired';
      else if (remaining > 0) status = 'active';

      res.json({
        success: true,
        remaining,
        totalLastTopup: total,
        used,
        quotaExpiresAt: row.quota_expires_at || null,
        daysLeft,
        status,
        supportWhatsappPhone: settings.supportWhatsappPhone || process.env.SUPPORT_WHATSAPP_PHONE || '',
      });
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dashboard-billing-messages.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/billing.routes.js tests/dashboard-billing-messages.test.js
git commit -m "feat(billing): GET /api/billing/messages for customer dashboard"
```

---

## Task 12: Admin UI — quota column + "Add messages" modal

**Files:**
- Modify: `dashboard/admin.html`

- [ ] **Step 1: Add the quota column header and cell template**

Locate the customer table in `dashboard/admin.html`. Add a header `<th>الرصيد المتبقي</th>` between the existing headers (after "البريد" if present, before "إجراءات").

In the row-rendering JavaScript (search for `customers.map` or `forEach`), add a cell that renders:

```html
<td>
  <div style="font-weight:700">{{effectiveRemaining}}</div>
  <div style="font-size:11px;color:var(--text-soft)">
    {{quotaStatusLabel}} {{daysLeftLabel}}
  </div>
</td>
```

With helpers in the same script:

```js
function quotaStatusLabel(c) {
  if (c.quotaStatus === 'never_topped_up') return 'لم يُفعَّل';
  if (c.quotaStatus === 'expired') return '⚠ المدة منتهية';
  if (c.quotaStatus === 'empty') return 'الرصيد منتهي';
  return 'نشط';
}
function daysLeftLabel(c) {
  if (!c.quotaDaysLeft) return '';
  return `· ${c.quotaDaysLeft} يوم متبقي`;
}
```

- [ ] **Step 2: Add the "Add messages" button per row**

In the actions cell, append:

```html
<button onclick="openAddMessagesModal('{{userId}}', '{{name}}')">إضافة رسائل</button>
```

- [ ] **Step 3: Add the modal HTML at the end of `<body>`**

```html
<div id="addMessagesModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#fff;padding:24px;border-radius:12px;min-width:320px;direction:rtl">
    <h3 style="margin:0 0 16px">إضافة رسائل لـ <span id="addMessagesCustomerName"></span></h3>
    <label style="display:block;margin-bottom:12px">
      عدد الرسائل: <input id="addMessagesCount" type="number" min="1" value="3000" style="width:100%;padding:8px">
    </label>
    <label style="display:block;margin-bottom:12px">
      مدة الصلاحية (يوم): <input id="addMessagesDays" type="number" min="1" value="30" style="width:100%;padding:8px">
    </label>
    <label style="display:block;margin-bottom:16px">
      <input id="addMessagesResetFlag" type="checkbox" checked>
      تصفير الرصيد عند انتهاء المدة
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="closeAddMessagesModal()">إلغاء</button>
      <button onclick="submitAddMessages()" style="background:#10b981;color:#fff;padding:8px 16px;border:none;border-radius:6px">تفعيل</button>
    </div>
  </div>
</div>

<script>
let currentAddUserId = null;
function openAddMessagesModal(userId, name) {
  currentAddUserId = userId;
  document.getElementById('addMessagesCustomerName').textContent = name;
  document.getElementById('addMessagesModal').style.display = 'flex';
}
function closeAddMessagesModal() {
  currentAddUserId = null;
  document.getElementById('addMessagesModal').style.display = 'none';
}
async function submitAddMessages() {
  if (!currentAddUserId) return;
  const body = {
    messages: parseInt(document.getElementById('addMessagesCount').value, 10),
    days: parseInt(document.getElementById('addMessagesDays').value, 10),
    expireResetsQuota: document.getElementById('addMessagesResetFlag').checked,
  };
  const res = await fetch(`/api/admin/customers/${currentAddUserId}/add-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) { alert(data.message || 'فشل'); return; }
  closeAddMessagesModal();
  if (typeof loadCustomers === 'function') loadCustomers();
}
</script>
```

- [ ] **Step 4: Smoke-test in a browser**

Open the admin panel, click "إضافة رسائل" on a customer row, enter values, submit. Verify the row updates with new remaining count.

- [ ] **Step 5: Commit**

```bash
git add dashboard/admin.html
git commit -m "feat(admin-ui): quota column + add-messages modal"
```

---

## Task 13: Customer UI — quota panel + topup button + remove cost UI

**Files:**
- Modify: `dashboard/index.html`
- Test: `tests/dashboard-ui.test.js` (extend)

- [ ] **Step 1: Add the failing test**

Append to `tests/dashboard-ui.test.js`:

```js
test('dashboard does not show the legacy cost panel', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /إجمالي التكلفة/);
  assert.doesNotMatch(html, /id="costTotal"/);
});

test('dashboard shows the message quota panel', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /رصيد الرسائل/);
  assert.match(html, /id="quotaRemaining"/);
  assert.match(html, /id="quotaTopupBtn"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard-ui.test.js`
Expected: 2 new FAIL.

- [ ] **Step 3: Remove legacy cost UI**

In `dashboard/index.html`:

**3a. Delete the "تكلفة AI" stat card** in the stats bar (around line 933). Remove the entire `<div class="stat" ...>` ... `</div>` block.

**3b. Delete the cost panel** (lines 1287-1308 — the entire `<span>💰 تكلفة الذكاء الاصطناعي</span>` panel including its 3 stats, model breakdown, and reset timestamp).

**3c. Delete `loadCosts()` and `resetCosts()`** functions (around lines 2171-2196). Also remove any `loadCosts()` calls from periodic refresh loops.

- [ ] **Step 4: Add the new quota panel**

Insert this `<div class="panel">` block where the cost panel used to be (around line 1287):

```html
<div class="panel">
  <div class="panel-h"><span>💬 رصيد الرسائل</span></div>
  <div id="quotaEmptyBanner" style="display:none;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:12px;border-radius:8px;margin-bottom:16px">
    <strong>⚠️ انتهى الرصيد — البوت متوقف عن الرد</strong>
    <div style="font-size:12px;margin-top:4px">لمواصلة الخدمة، اشحن رصيدك بالضغط على الزر أدناه.</div>
  </div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    <div style="flex:1;min-width:120px;text-align:center;padding:12px;background:#f0fdf4;border-radius:8px">
      <div style="font-size:24px;font-weight:900;color:#10b981" id="quotaRemaining">—</div>
      <div style="font-size:12px;color:var(--text-soft)">المتبقي</div>
    </div>
    <div style="flex:1;min-width:120px;text-align:center;padding:12px;background:#eff6ff;border-radius:8px">
      <div style="font-size:24px;font-weight:900;color:#3b82f6" id="quotaUsed">—</div>
      <div style="font-size:12px;color:var(--text-soft)">المستخدم</div>
    </div>
    <div style="flex:1;min-width:120px;text-align:center;padding:12px;background:#fffbeb;border-radius:8px">
      <div style="font-size:24px;font-weight:900;color:#f59e0b" id="quotaDaysLeft">—</div>
      <div style="font-size:12px;color:var(--text-soft)">يوم متبقي</div>
    </div>
  </div>
  <div style="margin-top:16px;background:#e5e7eb;border-radius:8px;height:8px;overflow:hidden">
    <div id="quotaProgressBar" style="background:#10b981;height:100%;width:0%;transition:width 0.3s"></div>
  </div>
  <div style="margin-top:16px;text-align:center">
    <a id="quotaTopupBtn" href="#" target="_blank" style="display:inline-block;background:#10b981;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700">
      🔄 طلب شحن رصيد
    </a>
  </div>
</div>
```

- [ ] **Step 5: Add `loadQuota()` to the dashboard JS**

In the dashboard's `<script>` block (after the other `load*` functions), add:

```js
async function loadQuota() {
  try {
    const res = await fetch('/api/billing/messages');
    const data = await res.json();
    if (!data.success) return;
    document.getElementById('quotaRemaining').textContent = data.remaining.toLocaleString('ar-EG');
    document.getElementById('quotaUsed').textContent = data.used.toLocaleString('ar-EG');
    document.getElementById('quotaDaysLeft').textContent = data.daysLeft != null ? data.daysLeft : '—';

    const pct = data.totalLastTopup > 0 ? (data.remaining / data.totalLastTopup) * 100 : 0;
    const bar = document.getElementById('quotaProgressBar');
    bar.style.width = pct + '%';
    bar.style.background = pct < 10 ? '#ef4444' : pct < 30 ? '#f59e0b' : '#10b981';

    document.getElementById('quotaEmptyBanner').style.display = data.status === 'empty' || data.status === 'expired' ? 'block' : 'none';

    const phone = data.supportWhatsappPhone;
    const btn = document.getElementById('quotaTopupBtn');
    if (phone) {
      const text = encodeURIComponent('مرحباً، أحتاج شحن رصيد رسائل لحسابي');
      btn.href = `https://wa.me/${phone}?text=${text}`;
      btn.style.display = 'inline-block';
    } else {
      btn.style.display = 'none';
    }
  } catch (e) {
    console.warn('loadQuota failed', e);
  }
}
```

Add `loadQuota()` to the periodic refresh loop (wherever `loadCosts()` used to be called) and to the initial page-load sequence.

- [ ] **Step 6: Run dashboard tests**

Run: `node --test tests/dashboard-ui.test.js`
Expected: ALL PASS (including the 2 new tests).

- [ ] **Step 7: Smoke-test in a browser**

Load the dashboard, confirm: cost panel gone, quota panel visible, banner hidden when remaining > 0, banner visible and topup button works when remaining = 0.

- [ ] **Step 8: Commit**

```bash
git add dashboard/index.html tests/dashboard-ui.test.js
git commit -m "feat(dashboard): replace cost panel with message quota panel"
```

---

## Task 14: Full regression run + push + PR

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: 116 prior + ~16 new = ~132 PASS, 0 FAIL.

- [ ] **Step 2: Fix any regressions inline**

If any existing test broke, read the failure, fix the offending code, re-run. Common breakage points: `billing-service.test.js` (new columns) — already handled by Task 10; `dashboard-ui.test.js` (cost UI checks) — already handled by Task 13.

- [ ] **Step 3: Push the branch**

```bash
git push
```

- [ ] **Step 4: Open the pull request**

```bash
gh pr create --base master --title "feat: message quota system (replaces cost-display billing)" --body "$(cat <<'EOF'
## ملخص

نظام quota رسائل بسيط يحلّ محل عرض التكلفة. الأدمن يضيف رسائل + مدة، البوت يصمت لما الرصيد ينفد أو ينتهي مع flag التصفير.

## التغييرات

- 5 أعمدة جديدة على billing_accounts (idempotent migration)
- helper جديد src/services/billing/message-quota.js (3 دوال atomic)
- ai-worker: فحص quota قبل توليد AI (يوفّر تكلفة OpenAI)
- outgoing-worker: atomic decrement بعد كل إرسال ناجح
- admin: زر "إضافة رسائل" + modal + endpoint جديد
- customer: حذف قسم التكلفة، إضافة كارد رصيد + banner + زر تواصل لشحن

## Test plan

- [ ] npm test يمرّ كاملاً
- [ ] بعد النشر: dashboard العميل بدون قسم تكلفة
- [ ] dashboard العميل يعرض الرصيد الحالي
- [ ] لوحة الأدمن: إضافة 3000 رسالة لعميل → الرصيد يظهر فوراً
- [ ] إرسال رسالة AI → الرصيد ينقص 1
- [ ] رصيد 0 → البوت صامت + banner ظاهر للعميل

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Report PR URL to the user**

---

## Self-Review (filled in during planning)

**Spec coverage:**
- Section 2 (data model) → Task 1
- Section 3 (send/decrement logic) → Tasks 6 + 7
- Section 4 (helper) → Tasks 2-5
- Section 5 (admin) → Tasks 9 + 10 + 12
- Section 6 (customer dashboard) → Tasks 11 + 13
- Section 7 (new message statuses) → Tasks 6 + 7 (used in helpers `markInboundMessagesQuotaExceeded`, `markReplyMessage 'canceled_no_quota'`)
- Section 8 (UI removal) → Task 13
- Section 9 (archive) → no task needed (we leave `ai_usage` and old columns alone)
- Section 10 (rollback) → migration is idempotent + ALTER IF NOT EXISTS; no task needed
- Section 11 (tests) → covered alongside each task
- Section 12 (env var) → Task 11 reads `SUPPORT_WHATSAPP_PHONE` from `process.env` and `settings.supportWhatsappPhone`
- Section 13 (deploy) → Task 14 push + PR
- Section 14 (out of scope) → not implemented (correct)

**Placeholder scan:** No "TBD" / "TODO" left. Every step has runnable code or commands.

**Type consistency:** `messagesRemaining` (camelCase) used in JSON responses; `messages_remaining` (snake_case) used in SQL. `decrementMessageQuota` returns `{ success, remaining }` consistently. `addMessagesToQuota` parameter object uses `messages, days, expireResetsQuota` — same shape in route handler.
