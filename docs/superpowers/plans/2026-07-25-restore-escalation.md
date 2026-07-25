# Restore Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the quality reviewer strict about facts and style without letting reviewer uncertainty hijack normal product replies or cancel customer sends.

**Architecture:** Split reviewer diagnostics from escalation routing. The reviewer may repair grounded content, but only deterministic customer-risk signals or an explicit transfer marker may route a handoff. Carry a handoff-acknowledgement flag through the outgoing payload so an escalation pause cannot cancel its own acknowledgement while a real later owner reply still can.

**Tech Stack:** Node.js CommonJS, PostgreSQL, BullMQ, OpenAI-compatible chat completions, Node test runner.

## Global Constraints

- Preserve all `user_id`, `channel_id`, `customer_id`, and `conversation_id` scoping.
- Preserve product grounding, pre-send review, duplicate suppression, and idempotent send reservations.
- Normal configured product questions, including duration and warranty, must be answered from full product data.
- Reviewer confidence, `needs_human`, or `decision=escalate` alone must not create a transfer.
- Explicit customer human requests and genuine high-risk cases must still transfer.
- A configured escalation pause must not cancel the acknowledgement belonging to the same escalation.

---

### Task 1: Remove Routing Authority From Quality Reviewers

**Files:**
- Modify: `src/services/ai/reply-quality-gate.js:386-456`
- Modify: `src/services/ai/reply-quality-gate.js:672-972`
- Modify: `src/services/ai/reply-quality-gate.js:1000-1127`
- Test: `tests/pre-send-human-handoff.test.js`
- Test: `tests/reply-quality-gate.test.js`

**Interfaces:**
- Consumes: `detectCustomerHandoffPattern(customerText)` and grounded merchant product data.
- Produces: `detectMandatoryHumanHandoff({customerText})` whose result depends on customer-risk signals, not reviewer metadata.

- [ ] **Step 1: Write failing reviewer-authority regression tests**

Add tests that make the reviewer return a correct grounded final reply while also
returning `needs_human=true`, `decision=escalate`, or low confidence:

```js
test('reviewer uncertainty cannot escalate a grounded Adobe variants answer', async () => {
  const answer = 'المتاح 4 أشهر بـ189 ريال أو 8 أشهر بـ289 ريال';
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerReturning({
      decision: 'pass',
      confidence: 0.2,
      needs_human: true,
      human_reason: 'unsupported_information',
      final_reply: answer,
    }),
    model: 'test-model',
    draft: answer,
    customerText: 'وش المدد المتاحة؟',
    history: [{ role: 'user', content: 'وش المدد المتاحة؟' }],
    config: adobeVariantsConfig,
    logger: silentLogger,
  });
  assert.equal(result.reply, answer);
  assert.equal(result.requiresHuman, false);
  assert.doesNotMatch(result.reply, /\[تحويل:/);
});
```

Add separate cases for low confidence and `decision=escalate`. Keep a positive
case proving `أبي أكلم موظف` still returns a transfer marker.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/pre-send-human-handoff.test.js tests/reply-quality-gate.test.js
```

Expected: the new grounded-duration and reviewer-uncertainty tests fail because
`detectMandatoryHumanHandoff` currently trusts reviewer routing fields.

- [ ] **Step 3: Make handoff detection customer-driven**

Change `detectMandatoryHumanHandoff` so it ignores `parsed.decision`,
`parsed.needsHuman`, reviewer confidence, and `unsupportedIssues`. It should call
`detectCustomerHandoffPattern(customerText)` and return only that deterministic
result.

Keep confidence and reviewer fields in audit data for diagnosis, but force
`requiresHuman` to the deterministic result.

Update both reviewer prompts with:

```text
أنت لا تملك قرار التحويل لموظف. أصلح الرد من مصادر المتجر أو اسأل سؤالاً
توضيحياً واحداً. حقول الثقة والتشخيص لا تغيّر مسار الإرسال.
```

Do not remove fact grounding or `applyGroundingFallback`.

- [ ] **Step 4: Make normal unsupported information honest without automatic routing**

When no high-risk customer pattern exists, return a marker-free safe response:

```js
function buildSafeUnknownReply() {
  return 'المعلومة مو واضحة عندي بشكل مؤكد، ممكن توضح لي المقصود أكثر؟';
}
```

The normal reply generator may still intentionally emit `[تحويل:...]` when the
merchant's explicit escalation rule applies. The quality reviewer must not add
one itself.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/pre-send-human-handoff.test.js tests/reply-quality-gate.test.js tests/escalation-routing.test.js
```

Expected: all tests pass, including explicit-human-request routing.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/services/ai/reply-quality-gate.js tests/pre-send-human-handoff.test.js tests/reply-quality-gate.test.js tests/escalation-routing.test.js
git commit -m "fix: separate reply review from escalation routing"
```

### Task 2: Prevent an Escalation Pause From Canceling Its Own Acknowledgement

**Files:**
- Modify: `src/workers/ai-worker.js:1028-1275`
- Modify: `src/workers/outgoing-whatsapp-worker.js:350-390`
- Modify: `src/workers/outgoing-whatsapp-worker.js:580-620`
- Modify: `src/workers/outgoing-whatsapp-worker.js:843-901`
- Test: `tests/outgoing-owner-pause-cancel.test.js`
- Test: `tests/owner-pause-lid-path.test.js`
- Test: `tests/owner-reply-cancels-pending-send.test.js`

**Interfaces:**
- Produces outgoing payload boolean `handoffAcknowledgement`.
- Extends `isConversationOwnerPaused({ ..., ignoreEscalationPause })`.

- [ ] **Step 1: Write failing pause-ordering tests**

Add a test with an active `escalated_until` and no human message:

```js
const paused = await isConversationOwnerPaused({
  userId: 'u1',
  conversationId: 'c1',
  sender: 'customer@s.whatsapp.net',
  replyMessageId: 'reply-1',
  ignoreEscalationPause: true,
  database,
});
assert.equal(paused, false);
```

Add another test using the same option but returning a real `sent_by_human`
message from the second query; assert `true`.

Add source-wiring assertions that both the normal and `@lid` outgoing paths pass
`ignoreEscalationPause: payload.handoffAcknowledgement === true`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test tests/outgoing-owner-pause-cancel.test.js tests/owner-pause-lid-path.test.js tests/owner-reply-cancels-pending-send.test.js
```

Expected: the active pause still returns `true` because the option does not yet
exist.

- [ ] **Step 3: Carry the handoff acknowledgement flag**

In `ai-worker.js`, add this field to the customer reply payload:

```js
handoffAcknowledgement: Boolean(escalation.ownerMessage),
```

Do not add it to the internal team-facing escalation job.

- [ ] **Step 4: Separate pause checks from real owner-interrupt checks**

Extend the function:

```js
async function isConversationOwnerPaused({
  userId,
  conversationId,
  sender,
  replyMessageId = null,
  ignoreEscalationPause = false,
  database = db,
}) {
```

Only return for `escalated_until` when `ignoreEscalationPause !== true`. Always
run the existing human-message query so a real later owner reply still cancels
the acknowledgement.

Pass the option in both normal and `@lid` branches.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/outgoing-owner-pause-cancel.test.js tests/owner-pause-lid-path.test.js tests/owner-reply-cancels-pending-send.test.js tests/escalation-and-owner-pause-options.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/workers/ai-worker.js src/workers/outgoing-whatsapp-worker.js tests/outgoing-owner-pause-cancel.test.js tests/owner-pause-lid-path.test.js tests/owner-reply-cancels-pending-send.test.js
git commit -m "fix: deliver handoff acknowledgement before pause"
```

### Task 3: Production Replay and Merchant Configuration

**Files:**
- Modify: `tests/pre-send-human-handoff.test.js`
- Modify: `tests/reply-quality-gate.test.js`
- Production configuration: tenant `45466100-834a-49aa-b4c8-91b4fea458a1`

**Interfaces:**
- Consumes the configured Adobe variants and current customer text.
- Produces a normal grounded answer without handoff.

- [ ] **Step 1: Add the exact production replay**

Use:

```js
const customerText = 'وش المدد المتاحة؟';
const products = [{
  name: 'إشتراك أدوبي كرييتف كلاود',
  variants: [
    { label: 'اشتراك 4 اشهر', price: '189' },
    { label: 'اشتراك 8 اشهر', price: '289' },
  ],
}];
```

Assert that the final output contains `4 اشهر`, `8 اشهر`, `189`, and `289`, has
no transfer marker, and is not suppressed.

- [ ] **Step 2: Run the replay tests**

Run:

```powershell
node --test tests/pre-send-human-handoff.test.js tests/reply-quality-gate.test.js
```

Expected: PASS.

- [ ] **Step 3: Reset the merchant pause setting after code deployment**

Run a tenant-scoped update only after the new deployment succeeds:

```sql
UPDATE bot_configs
SET config = jsonb_set(config, '{escalationPausesBot}', 'false'::jsonb, true)
WHERE user_id = '45466100-834a-49aa-b4c8-91b4fea458a1';
```

Read the row back and verify `config->>'escalationPausesBot' = 'false'`.

### Task 4: Verify, Review, and Deploy

**Files:**
- Verify all files changed by Tasks 1-3.

**Interfaces:**
- Produces commit(s) ready for `master` and a healthy Railway deployment.

- [ ] **Step 1: Run complete verification**

```powershell
npm test
git diff --check
git status --short
```

Expected: zero test failures and only intentional files changed.

- [ ] **Step 2: Request independent code review**

Review the changes against base commit `57cfa1e`, focusing on false-negative
escalations, tenant scope, owner interruption, and `@lid` parity. Fix every
Critical or Important finding and rerun the complete suite.

- [ ] **Step 3: Push the feature and production branches**

```powershell
git push origin HEAD:codex/enforce-merchant-reply-style
git push origin HEAD:master
```

- [ ] **Step 4: Verify production**

Confirm Railway shows the new commit as `Deployment successful`, then verify:

```powershell
Invoke-WebRequest -Uri 'https://jwap.net/health' -UseBasicParsing -TimeoutSec 30
```

Expected: HTTP 200 with `ready=true`, migrations completed, and outgoing workers
ready.

- [ ] **Step 5: Run the live customer scenario**

Send:

```text
بسألك بخصوص اشتراك أدوبي
وش المدد المتاحة؟
وهل هو مضمون؟
```

Expected: one grounded reply containing configured durations and warranty, no
generic handoff, no employee name, and no canceled outgoing row.

