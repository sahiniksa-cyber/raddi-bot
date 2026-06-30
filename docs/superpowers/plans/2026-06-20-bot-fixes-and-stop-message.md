# Week-1 Bot Fixes + Stop Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four bot-behavior issues (duplicate replies, owner-interrupt race, dropped questions, hallucinated answers) and add a platform-level "messages quota exhausted" message.

**Architecture:** Issues 1–2 are bugs requiring root-cause confirmation via a failing reproduction test before the fix. Issues 3–4 are prompt-instruction edits in `lib/ai-client.js` verified by snapshot/string tests. Issue 5 is a new platform-wide key-value setting (`platform_settings` table) read by `ai-worker.js` at the quota-exhausted branch to send the configured message once per conversation.

**Tech Stack:** Node.js, Baileys, BullMQ, PostgreSQL (pg), Redis, Jest, Express, vanilla JS dashboard.

**Batches (separate review/deploy units):**
- **Batch A** = Tasks 1–4 (bot behavior). 
- **Batch B** = Tasks 5–9 (quota stop message).

**Test command:** `npx jest <file> --runInBand` for one file; `npm test` for the full suite (~924 tests) before each batch is declared done.

---

## Batch A — Bot Behavior

### Task 1: Confirm + fix duplicate-reply root cause (Issue 1)

**Files:**
- Investigate: `src/workers/ai-worker.js` (`enqueueFollowupIfPending` ~258-283, completed handler ~1080-1109, dedup call ~776), `src/workers/reply-deduplication.js`
- Test: `tests/ai-worker-no-duplicate-rephrase.test.js` (create)
- Modify: `src/workers/ai-worker.js` (fix site confirmed by the test)

- [ ] **Step 1: Reproduce — write a failing test**

Goal of the test: simulate the suspected path — a second AI job for the same conversation produces a near-duplicate (different wording) reply that still gets enqueued/sent. Use the existing test patterns in `tests/ai-worker-quota.test.js` / `tests/ai-failure-fallback.test.js` for the in-memory db + queue mocks.

The test asserts: when the last assistant reply in the conversation is semantically a near-duplicate (Jaccard ≥ 0.85 after `normalize`) of the new candidate, the worker does NOT enqueue a second outgoing reply (it skips instead of "send original anyway").

```js
// tests/ai-worker-no-duplicate-rephrase.test.js
const { findDuplicateRecentReply } = require('../src/workers/reply-deduplication');

test('near-duplicate reply after regeneration is suppressed, not sent', async () => {
  // Arrange an in-memory db where the last assistant reply is a paraphrase
  // of the candidate the AI client returns, regeneration also returns a paraphrase,
  // and assert no outgoing job is enqueued for the duplicate.
  // (Build with the same harness as tests/ai-worker-quota.test.js.)
});
```

- [ ] **Step 2: Run it — confirm it fails (documents current behavior)**

Run: `npx jest tests/ai-worker-no-duplicate-rephrase.test.js --runInBand`
Expected: FAIL — current code sends the original even when regeneration stays duplicate (ai-worker ~792-799 per mapping).

- [ ] **Step 3: Confirm the actual root cause before coding the fix**

Use superpowers:systematic-debugging. Read ai-worker.js lines 760-860 (dedup + regenerate + "send anyway") and 1080-1109 (`enqueueFollowupIfPending`). Confirm WHICH path produces the second worded reply: (a) regenerate-then-send-original, or (b) follow-up job re-answering. Write the finding as a comment in the test file. Do NOT proceed to Step 4 until the failing test reproduces the confirmed path; if neither path reproduces it, STOP and report to the user.

- [ ] **Step 4: Implement the minimal fix at the confirmed site**

If path (a): when `findDuplicateRecentReply` still matches after regeneration, skip enqueuing the outgoing reply (return a `skipped: 'duplicate_suppressed'` outcome) instead of sending the original. If path (b): in `enqueueFollowupIfPending`, before enqueuing, drop pending messages already covered by the just-sent reply. Implement only the confirmed path.

- [ ] **Step 5: Run the test — confirm it passes**

Run: `npx jest tests/ai-worker-no-duplicate-rephrase.test.js --runInBand`
Expected: PASS.

- [ ] **Step 6: Run related suites to confirm no regression**

Run: `npx jest tests/ai-worker-quota.test.js tests/ai-failure-fallback.test.js tests/reply-deduplication.test.js --runInBand` (include `reply-deduplication.test.js` only if it exists)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/ai-worker-no-duplicate-rephrase.test.js src/workers/ai-worker.js
git commit -m "fix(ai): suppress near-duplicate rephrased reply instead of sending it"
```

### Task 2: Confirm + fix owner-interrupt race (Issue 2)

**Files:**
- Investigate: `src/services/whatsapp/message-ingest.service.js` (owner pause ~354-511), `src/workers/outgoing-whatsapp-worker.js` (`isConversationOwnerPaused` ~456-493, pre-send check ~162), `src/workers/ai-worker.js` (escalation mute ~580), `lib/constants.js` (DEFAULT_CONFIG `ownerPauseMinutes`)
- Test: `tests/owner-interrupt-presend.test.js` (create)
- Modify: confirmed site (likely `lib/constants.js` default and/or the fact-based pre-send query)

- [ ] **Step 1: Reproduce — write a failing test**

Two scenarios to encode (pick the one that reproduces during Step 3):
- (A) `ownerPauseMinutes` defaulting to 0 → owner reply never sets `escalated_until` → AI reply sends after owner. Assert the default config yields a pause window > 0.
- (B) Owner reply row exists in `messages` with `direction='outbound'`, `status='sent_by_human'`, `created_at` AFTER the AI reply's `created_at`, but pre-send `isConversationOwnerPaused` returns false. Assert it returns true (cancel).

```js
// tests/owner-interrupt-presend.test.js
// Build the in-memory db harness like tests/owner-pause.test.js and
// no-duplicate-sends-and-media-pause.test.js. Assert the pre-send guard
// cancels the AI reply once a human outbound exists after the AI reply.
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/owner-interrupt-presend.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Confirm root cause (systematic-debugging)**

Read `DEFAULT_CONFIG.ownerPauseMinutes` in `lib/constants.js` and `resolveOwnerPauseMinutes`/`ownerPauseExpiry` in message-ingest. Confirm whether the user's real failure is the disabled default (A) or the fact-based query timing (B). Record the finding in the test file comment. STOP and report if neither reproduces.

- [ ] **Step 4: Implement the minimal fix**

- If (A): set a sane non-zero default for `ownerPauseMinutes` in `lib/constants.js` (e.g. 30) so owner-pause is on out of the box, and ensure existing merchant configs without the field inherit it via the merge in `resolveConfigForAI`.
- If (B): broaden the fact-based pre-send query in `isConversationOwnerPaused` so it catches the human reply regardless of the millisecond ordering (e.g. compare against the AI reply's conversation, not strict `created_at >`), keeping the existing flag check.

- [ ] **Step 5: Run the test — confirm it passes**

Run: `npx jest tests/owner-interrupt-presend.test.js --runInBand`
Expected: PASS.

- [ ] **Step 6: Run related suites**

Run: `npx jest tests/owner-pause.test.js tests/no-duplicate-sends-and-media-pause.test.js --runInBand`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/owner-interrupt-presend.test.js lib/constants.js src/workers/outgoing-whatsapp-worker.js
git commit -m "fix(ai): stop AI reply the moment the owner replies (owner-interrupt race)"
```

### Task 3: Fix dropped-questions prompt conflict (Issue 3)

**Files:**
- Modify: `lib/ai-client.js:170` and `lib/ai-client.js:185` (combined-text instruction lives in `src/workers/ai-worker.js` ~325)
- Modify: `src/workers/ai-worker.js` (`buildCombinedInboundText` ~319-329)
- Test: `tests/ai-prompt-answers-all-questions.test.js` (create)

**Root conflict:** Line 170 ("أعطِ مساراً واحداً واضحاً فقط") + ai-worker combined text ("لا تجمع عدة مسارات في رد واحد") fight with line 172 ("جاوب على جميع الأسئلة").

- [ ] **Step 1: Write the failing test**

```js
// tests/ai-prompt-answers-all-questions.test.js
const { AIClient } = require('../lib/ai-client');
test('system prompt instructs answering every question without the one-path contradiction', () => {
  const ai = new AIClient({ config: { storeName: 'x' }, logger: console });
  const sys = ai.buildSystemPrompt([], { latestUserText: 'سؤالين؟' });
  expect(sys).toMatch(/جاوب على (جميع|كل) الأسئلة/);
  // The contradictory phrasing must be gone / reworded:
  expect(sys).not.toMatch(/مساراً واحداً واضحاً فقط/);
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/ai-prompt-answers-all-questions.test.js --runInBand`
Expected: FAIL (current prompt still contains "مساراً واحداً واضحاً فقط").

- [ ] **Step 3: Reword line 170 to remove the conflict**

Replace the line 170 bullet so "one path" applies only to NOT mixing "ask the customer for info" with "promise escalation" for the **same** matter — while explicitly keeping "answer every distinct question". Suggested replacement text:

```
- افهم نية العميل من رسالته كاملة أولاً وجاوب على كل أسئلته في ردّ واحد متماسك بدون أن تترك أي سؤال. القاعدة الوحيدة: لا تجمع لنفس الطلب بين طلب معلومة من العميل ووعدٍ بالتحويل/التصعيد (متناقضان). إن كانت نية العميل غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
```

- [ ] **Step 4: Align the combined-inbound instruction in ai-worker**

In `src/workers/ai-worker.js` `buildCombinedInboundText`, change "لا تجمع عدة مسارات في رد واحد" so it no longer reads as "drop some questions". Suggested:

```
'هذه رسائل متتالية من نفس العميل. افهم نيته الكاملة منها مجتمعةً وردّ برد واحد متماسك يجاوب على كل ما سأل عنه بدون أن تترك أي سؤال، دون أن تكرر أو تتناقض:'
```

- [ ] **Step 5: Run the test — confirm it passes**

Run: `npx jest tests/ai-prompt-answers-all-questions.test.js --runInBand`
Expected: PASS.

- [ ] **Step 6: Run prompt-related suites**

Run: `npx jest tests/meta-prompts-integration.test.js --runInBand`
Expected: PASS (update snapshot expectations there if they assert the old wording).

- [ ] **Step 7: Commit**

```bash
git add tests/ai-prompt-answers-all-questions.test.js lib/ai-client.js src/workers/ai-worker.js
git commit -m "fix(ai): answer every question — remove one-path vs all-questions conflict"
```

### Task 4: Strengthen "don't guess when you don't understand" (Issue 4)

**Files:**
- Modify: `lib/ai-client.js` knowledgeRules block (~175-176)
- Test: `tests/ai-prompt-no-guess-on-unknown.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// tests/ai-prompt-no-guess-on-unknown.test.js
const { AIClient } = require('../lib/ai-client');
test('prompt forbids guessing and requires clarify-or-escalate on not-understood requests', () => {
  const ai = new AIClient({ config: { storeName: 'x' }, logger: console });
  const sys = ai.buildSystemPrompt([], { latestUserText: 'شي غامض' });
  expect(sys).toMatch(/إذا لم تفهم طلب العميل/);
  expect(sys).toMatch(/اطلب توضيح|صعّد/);
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/ai-prompt-no-guess-on-unknown.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Add an explicit not-understood rule to knowledgeRules**

Append a bullet near line 176 in `lib/ai-client.js`:

```
- إذا لم تفهم طلب العميل أو لم تكن متأكداً من المقصود، لا تخمّن ولا ترمِ رداً عاماً: اطلب توضيحاً قصيراً محدداً، أو صعّد للمختص إذا كان الموضوع خارج معلوماتك. الرد الخاطئ بثقة أسوأ من سؤال توضيحي.
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx jest tests/ai-prompt-no-guess-on-unknown.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Full suite for Batch A**

Run: `npm test`
Expected: PASS (~924). Fix any snapshot tests that asserted old prompt wording.

- [ ] **Step 6: Commit**

```bash
git add tests/ai-prompt-no-guess-on-unknown.test.js lib/ai-client.js
git commit -m "fix(ai): clarify-or-escalate instead of guessing on not-understood requests"
```

---

## Batch B — Quota Stop Message (platform-level)

### Task 5: `platform_settings` table + service

**Files:**
- Modify: `src/db/migrations/init.js` (add table)
- Create: `src/services/platform/platform-settings.js`
- Test: `tests/platform-settings.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// tests/platform-settings.test.js
const { getPlatformSetting, setPlatformSetting } = require('../src/services/platform/platform-settings');
test('get returns default when unset, set persists and round-trips', async () => {
  const fakeDb = makeFakeDb(); // {} -> rows; mirror tests/admin-add-messages.test.js style
  expect(await getPlatformSetting('quotaStopMessage', { database: fakeDb })).toBeNull();
  await setPlatformSetting('quotaStopMessage', { enabled: true, text: 'مرحبا' }, { database: fakeDb });
  expect(await getPlatformSetting('quotaStopMessage', { database: fakeDb })).toEqual({ enabled: true, text: 'مرحبا' });
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/platform-settings.test.js --runInBand`
Expected: FAIL (module missing).

- [ ] **Step 3: Add migration**

In `src/db/migrations/init.js`, add:

```sql
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

- [ ] **Step 4: Implement the service**

```js
// src/services/platform/platform-settings.js
'use strict';
const db = require('../../db/client');

async function getPlatformSetting(key, { database = db } = {}) {
  const r = await database.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setPlatformSetting(key, value, { database = db } = {}) {
  await database.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
  return value;
}

module.exports = { getPlatformSetting, setPlatformSetting };
```

- [ ] **Step 5: Run the test — confirm it passes**

Run: `npx jest tests/platform-settings.test.js --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/init.js src/services/platform/platform-settings.js tests/platform-settings.test.js
git commit -m "feat(platform): platform_settings key-value store + service"
```

### Task 6: Admin GET/PUT endpoint for the quota stop message

**Files:**
- Modify: `src/routes/admin.routes.js` (add two routes)
- Test: `tests/admin-quota-stop-message-routes.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-quota-stop-message-routes.test.js
// Mount createAdminRoutes with requireAuth/requireOwner stubbed to pass-through
// (mirror tests/admin-api-keys-routes.test.js). Assert:
//   GET  /api/admin/quota-stop-message returns {success:true, setting:{...}}
//   PUT  /api/admin/quota-stop-message {enabled, text} persists via setPlatformSetting
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/admin-quota-stop-message-routes.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Add routes**

In `src/routes/admin.routes.js` (after the coupons block), require the service at top and add:

```js
router.get('/api/admin/quota-stop-message', requireOwner, async (req, res, next) => {
  try {
    const setting = await getPlatformSetting('quotaStopMessage');
    res.json({ success: true, setting: setting || { enabled: false, text: '' } });
  } catch (err) { next(err); }
});

router.put('/api/admin/quota-stop-message', requireOwner, async (req, res, next) => {
  try {
    const enabled = req.body?.enabled === true;
    const text = String(req.body?.text || '').trim();
    await setPlatformSetting('quotaStopMessage', { enabled, text });
    res.json({ success: true, setting: { enabled, text } });
  } catch (err) { next(err); }
});
```

Add the import near the other service requires:
```js
const { getPlatformSetting, setPlatformSetting } = require('../services/platform/platform-settings');
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx jest tests/admin-quota-stop-message-routes.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.routes.js tests/admin-quota-stop-message-routes.test.js
git commit -m "feat(admin): GET/PUT quota stop message platform setting"
```

### Task 7: Admin dashboard UI section

**Files:**
- Modify: `dashboard/admin.html` (add a settings card + load/save JS)
- Test: `tests/admin-dashboard-has-quota-stop-message.test.js` (create — static HTML assertion, mirror `tests/admin-dashboard-has-api-keys-section.test.js`)

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-dashboard-has-quota-stop-message.test.js
const fs = require('fs');
const path = require('path');
test('admin.html has the quota stop message controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'admin.html'), 'utf8');
  expect(html).toContain('quotaStopMessageText');
  expect(html).toContain('quotaStopMessageEnabled');
  expect(html).toContain('/api/admin/quota-stop-message');
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/admin-dashboard-has-quota-stop-message.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Add the card + JS to admin.html**

Add a card (match existing admin.html card markup) containing a checkbox `id="quotaStopMessageEnabled"`, a textarea `id="quotaStopMessageText"` with placeholder of the default text, a save button, and JS that GETs on load and PUTs on save to `/api/admin/quota-stop-message`.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx jest tests/admin-dashboard-has-quota-stop-message.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/admin.html tests/admin-dashboard-has-quota-stop-message.test.js
git commit -m "feat(admin): dashboard UI for quota stop message"
```

### Task 8: Send the message once per conversation when quota is exhausted

**Files:**
- Modify: `src/workers/ai-worker.js` (quota-exhausted branch ~683-697)
- Create helper: reuse outgoing enqueue path already used for normal replies
- Test: `tests/ai-worker-quota-stop-message.test.js` (create)

**Default text constant:** add to `lib/constants.js`:
```js
const DEFAULT_QUOTA_STOP_MESSAGE = 'نعتذر، خدمة الردّ الآلي متوقفة مؤقتاً. سيتم الرد عليك في أقرب وقت 🙏';
```

- [ ] **Step 1: Write the failing test**

```js
// tests/ai-worker-quota-stop-message.test.js
// Harness like tests/ai-worker-quota.test.js. With quota exhausted AND
// platform setting {enabled:true, text:'...'}:
//   - first inbound for a conversation => one outgoing "stop message" enqueued
//   - second inbound for the SAME conversation => NO second stop message
// With {enabled:false} => silent (current behavior), no message.
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx jest tests/ai-worker-quota-stop-message.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Implement in the quota-exhausted branch**

At ai-worker.js ~683 where `!quota.canReply`, before returning, read the platform setting; if `enabled && text` and no prior stop message exists for this conversation (query messages for a row tagged `raw_payload->>'kind' = 'quota_stop'`), enqueue ONE outgoing message with that tag. The quota-exhausted message must NOT decrement quota — enqueue it on a path exempt from the quota block. Reuse `payload.escalation`-style exemption OR add an analogous `payload.systemNotice` flag honored by `shouldBlockOutgoingForQuota` in outgoing-whatsapp-worker.js (add `if (payload.systemNotice) return false;`). Keep "once per conversation" by the prior-message check.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx jest tests/ai-worker-quota-stop-message.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Run quota suites for regression**

Run: `npx jest tests/ai-worker-quota.test.js tests/outgoing-worker-quota.test.js tests/outgoing-quota-hard-stop.test.js --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/ai-worker.js src/workers/outgoing-whatsapp-worker.js lib/constants.js tests/ai-worker-quota-stop-message.test.js
git commit -m "feat(ai): send platform quota-stop message once per customer when balance empty"
```

### Task 9: Full suite + batch close

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS (~924 + new tests).

- [ ] **Step 2: Report results to the user and decide deploy order (Batch A first, then Batch B).**

---

## Self-Review Notes
- Issues 1 & 2 fixes are gated on a reproducing test + systematic-debugging confirmation; if the hypothesized root cause does not reproduce, STOP and report (no surface patches).
- Issue 5 message is platform-level (admin), single field + enable toggle, sent once per conversation, never decrements quota, default silent when disabled — matches the user's decisions.
- Token expiry is intentionally out of scope (user: token does not reset messages; feature is for messages quota only).
