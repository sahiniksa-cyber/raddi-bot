# Group Escalation + Quota Counter Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two production-verified bugs: (1) escalation to a WhatsApp GROUP never delivers because merchants type the group NAME while the code only accepts a literal `@g.us` JID; (2) the dashboard sent/remaining counters don't move because @lid sends (the MAJORITY of sends: 423 of 468 since quota launch) bypass `decrementMessageQuota`, and the "used" metric is derived (`last_topup - remaining`) instead of tracked.

**Architecture:** Three surgical fixes. (A) `handleLidOutgoing` decrements quota on success like the main path. (B) A true `messages_used` counter column incremented atomically by the same UPDATE that decrements, with a one-time backfill preserving currently displayed values; the billing endpoint reads it directly. (C) Escalation targets that aren't phone/JID flow through as raw group names; the outgoing worker (the only process with a live WhatsApp socket) resolves name → group JID via `groupFetchAllParticipating()` with normalized-Arabic matching and a TTL cache; unresolvable names cancel with an explicit error instead of silently rerouting. Bare long digit strings (16+) are treated as group IDs.

**Production evidence (2026-06-10, read-only queries):**
- Owner config: `escalationContacts[0].phone = "متجر برو خدمة عملاء"` (a NAME) → `normalizeEscalationPhone` strips to empty → contact dropped.
- Owner account: 293 sent since 2026-05-24, only 41 carried `quotaRemainingAfter` (decremented); 248 were `lid` sends. Second merchant: 175/175 lid, 0 decremented.
- Multi-topup freeze: user `9b200a56` has remaining=6000 > last_topup=3000 → `used = max(0, 3000-6000) = 0` frozen.

**Out of scope (deliberate):** dashboard manual sends (`/api/send-message`) stay un-metered — they are the OWNER typing, not bot service; charging them is a product decision flagged in the report. No retroactive deduction of the ~430 historical un-metered sends.

---

### Task 1: @lid sends decrement quota

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js` (handleLidOutgoing, after the successful `bot.client.sendMessage`)
- Test: `tests/outgoing-worker-quota.test.js` (extend; follows the file's existing source-structure style)

- [ ] **Step 1: Write the failing test** — append to `tests/outgoing-worker-quota.test.js`:

```js
test('lid best-effort send also decrements quota after success', () => {
  const lidStart = workerSource.indexOf('async function handleLidOutgoing');
  const lidEnd = workerSource.indexOf('async function notifyOwnerOfLidFailure');
  const lidBody = workerSource.slice(lidStart, lidEnd);
  const sendIdx = lidBody.indexOf('bot.client.sendMessage');
  const decIdx = lidBody.indexOf('decrementMessageQuota');
  assert.ok(sendIdx > -1, 'lid path must send via bot.client.sendMessage');
  assert.ok(decIdx > sendIdx, 'decrementMessageQuota must run AFTER the lid send succeeds');
  assert.match(lidBody, /quotaRemainingAfter/);
});
```

- [ ] **Step 2: Run** `node --test tests/outgoing-worker-quota.test.js` — expect the new test FAILS.
- [ ] **Step 3: Implement** — in `handleLidOutgoing`, after `recordWhatsappMessageId(...)` and before `markReplyMessage(replyMessageId, 'sent', ...)`:

```js
    const dec = await decrementMessageQuota(userId);
    if (!dec.success) {
      console.warn(`${new Date().toISOString()} [${WORKER_NAME}] lid-sent ${replyMessageId} but quota already empty for ${userId}`);
    }
    await markReplyMessage(replyMessageId, 'sent', {
      sentBy: WORKER_NAME,
      sentAt: new Date().toISOString(),
      lid: true,
      quotaRemainingAfter: dec.remaining ?? 0,
    });
```

- [ ] **Step 4: Run** the test file again — expect PASS (all tests).
- [ ] **Step 5: Commit** `fix(quota): lid best-effort sends now decrement the message quota`.

---

### Task 2: True `messages_used` counter

**Files:**
- Modify: `src/db/migrations/init.js` (new ALTER + one-time backfill UPDATE, following the existing `ADD COLUMN IF NOT EXISTS` pattern at lines 222-230)
- Modify: `src/services/billing/message-quota.js` (`decrementMessageQuota` UPDATE)
- Modify: `src/routes/billing.routes.js:152-188` (`used` from the column)
- Test: `tests/message-quota.test.js` + `tests/dashboard-billing-messages.test.js` (inspect style first, extend accordingly)

- [ ] **Step 1: Migration** — append to the migrations list in `init.js`:

```js
  `ALTER TABLE billing_accounts
     ADD COLUMN IF NOT EXISTS messages_used INTEGER NOT NULL DEFAULT 0`,
  // One-time backfill: seed the tracked counter with the value the dashboard
  // currently derives, so the visible number never jumps backward.
  `UPDATE billing_accounts
      SET messages_used = GREATEST(0, last_topup_amount - messages_remaining)
    WHERE messages_used = 0 AND last_topup_amount > messages_remaining`,
```

- [ ] **Step 2: Failing test** — extend the quota tests to assert the decrement SQL also increments `messages_used`, and the billing route reads `messages_used` (style per existing tests in those files).
- [ ] **Step 3: Implement** — `decrementMessageQuota` UPDATE becomes:

```js
    `UPDATE billing_accounts
     SET messages_remaining = messages_remaining - 1,
         messages_used = messages_used + 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND messages_remaining > 0
       AND (
         NOT expire_resets_quota
         OR quota_expires_at IS NULL
         OR quota_expires_at > NOW()
       )
     RETURNING messages_remaining`,
```

And in `billing.routes.js`: add `messages_used` to the SELECT; `const used = Number(row.messages_used || 0);` (drop the `total - remaining` derivation).

- [ ] **Step 4: Run** both test files — expect PASS.
- [ ] **Step 5: Commit** `fix(billing): track messages_used directly so the dashboard counter survives multiple topups`.

---

### Task 3: Escalation reaches groups configured by NAME (or bare ID)

**Files:**
- Modify: `src/workers/escalation-routing.js` (export `normalizeArabic`; group-ID heuristic; pass names through)
- Create: `src/services/whatsapp/group-resolver.js`
- Modify: `src/workers/outgoing-whatsapp-worker.js` (resolve before send for escalation payloads)
- Tests: `tests/escalation-routing.test.js` (extend), `tests/group-resolver.test.js` (new)

- [ ] **Step 1: Failing tests** —

`tests/escalation-routing.test.js` additions:
```js
test('bare 16+ digit targets are treated as group IDs', () => {
  assert.equal(normalizeEscalationTarget('120363419087654321'), '120363419087654321@g.us');
  assert.equal(normalizeEscalationTarget('966501234567'), '966501234567@c.us');
});

test('prepareEscalation passes a group NAME through for send-time resolution', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: 'متجر برو خدمة عملاء', when: 'مشكلة' }] };
  const result = prepareEscalation({
    reply: 'أبشر [تحويل:الدعم|مشكلة شحن]',
    config,
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'مشكلة في الشحن',
  });
  assert.ok(result.ownerMessage, 'name target must NOT be dropped');
  assert.equal(result.ownerMessage.sender, 'متجر برو خدمة عملاء');
  assert.equal(result.ownerMessage.needsGroupResolution, true);
});
```

`tests/group-resolver.test.js` (new): fake bot `{ userId, sock: { groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us', subject: 'متجر برو خدمة عملاء' }, 'b@g.us': { id: 'b@g.us', subject: 'فريق الشحن' } }) } }` — assert exact normalized match, partial (includes) match, no-match → null, no-sock → null, and that a second call uses the cache (count fetch invocations).

- [ ] **Step 2: Run both** — expect FAIL (function/file missing).
- [ ] **Step 3: Implement** —

`escalation-routing.js`:
```js
const GROUP_ID_MIN_DIGITS = 16; // longest real phone is 15 digits (E.164); WhatsApp group ids are 18+

function normalizeEscalationTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;
  if (raw.endsWith('@g.us') || raw.endsWith('@c.us') || raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw;
  const digits = cleanDigits(raw);
  if (digits && digits === raw.replace(/[\s+-]/g, '') && digits.length >= GROUP_ID_MIN_DIGITS) return `${digits}@g.us`;
  return normalizeEscalationPhone(raw);
}
```
In `prepareEscalation`, replace `if (!target) return { customerReply, ownerMessage: null };` with: when raw target is non-empty text, return the ownerMessage using `sender: rawTarget` + `needsGroupResolution: true` (same notification body). Export `normalizeArabic`.

`src/services/whatsapp/group-resolver.js`:
```js
'use strict';
const { normalizeArabic } = require('../../workers/escalation-routing');

const CACHE_TTL_MS = parseInt(process.env.GROUP_RESOLVE_CACHE_TTL_MS || '600000', 10);
const cache = new Map(); // userId -> { at, groups: [{jid, subject}] }

async function fetchGroups(bot) {
  const cached = cache.get(bot.userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.groups;
  const sock = bot?.sock;
  if (!sock?.groupFetchAllParticipating) return null;
  const raw = await sock.groupFetchAllParticipating();
  const groups = Object.values(raw || {}).map(g => ({ jid: g.id, subject: String(g.subject || '') }));
  cache.set(bot.userId, { at: Date.now(), groups });
  return groups;
}

// Resolves a human-entered group NAME to its @g.us JID. Exact normalized match
// wins; otherwise a unique includes-match. Returns null when not found — the
// caller must fail loudly rather than guess.
async function resolveGroupJidByName(bot, name) {
  const wanted = normalizeArabic(name);
  if (!wanted) return null;
  const groups = await fetchGroups(bot);
  if (!groups) return null;
  const exact = groups.filter(g => normalizeArabic(g.subject) === wanted);
  if (exact.length === 1) return exact[0].jid;
  const partial = groups.filter(g => normalizeArabic(g.subject).includes(wanted) || wanted.includes(normalizeArabic(g.subject)));
  return partial.length === 1 ? partial[0].jid : null;
}

module.exports = { resolveGroupJidByName, __cache: cache };
```

`outgoing-whatsapp-worker.js` — in `processOutgoingWhatsapp` after the `isSocketOpen` guard:
```js
  // Escalation contacts may be configured with a group NAME (merchants cannot
  // know the literal @g.us id). Resolve it against the account's joined groups
  // now that we hold a live socket. Unresolvable => cancel loudly, never guess.
  let deliverTo = sender;
  if (payload.escalation && !String(sender).includes('@')) {
    deliverTo = await resolveGroupJidByName(bot, sender);
    if (!deliverTo) {
      const message = `escalation group not found by name: ${sender}`;
      await markReplyMessage(replyMessageId, 'canceled', { sentBy: WORKER_NAME, canceledAt: new Date().toISOString(), error: message });
      await updateJobStatus(job.id, { status: 'canceled', finished_at: new Date(), attempts: job.attemptsMade, last_error: message });
      return { skipped: true, reason: 'escalation_group_not_found' };
    }
  }
```
…and use `deliverTo` for `sendPresenceUpdate` + `sendWhatsappReply` + the success log.

- [ ] **Step 4: Run** `node --test tests/escalation-routing.test.js tests/group-resolver.test.js tests/escalation-job-key.test.js tests/escalation-lid.test.js tests/bot-transfer-escalation.test.js tests/outgoing-worker-quota.test.js` — expect ALL PASS.
- [ ] **Step 5: Commit** `fix(escalation): resolve group names to @g.us at send time so group escalation actually delivers`.

---

### Task 4: Verification + ship

- [ ] Full suite in 3 batches (`node --test` over tests/*.test.js excluding the known-leaky `runtime-bot-stability-fixes.test.js`, which is run individually) — ALL PASS required.
- [ ] `git diff master...HEAD --stat` — only intended files.
- [ ] Delete the temp diagnostics file `tmp-diag-readonly.js` from the MAIN repo folder (it lives outside this worktree).
- [ ] Push + `gh pr create` (squash convention) with the production evidence in the body.
- [ ] Post-merge manual verification: trigger a test escalation (message that matches the contact's `when` rule) and confirm it lands in the "متجر برو خدمة عملاء" group; send a test customer message and watch `المتبقي` decrease by 1 in the dashboard.
