# Hide @lid in Old Conversations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw `xxx@lid` identifiers with a friendly masked label ("عميل ····0304" + "قديمة" badge) for conversations created before Phase A deployment, in both dashboard UI and escalation notifications.

**Architecture:** Display-only change in 3 source files (`conversations.controller.js`, `escalation-routing.js`, `dashboard/index.html`). The DB, AI client, queues, and Baileys stack remain untouched. Backwards compatibility for new conversations (with `phone_number`) is preserved verbatim.

**Tech Stack:** Node.js `node:test` runner, Express controller, vanilla JS dashboard, CSS in `dashboard/conversations.css`.

**Spec:** [docs/superpowers/specs/2026-05-25-hide-lid-old-conversations-design.md](../specs/2026-05-25-hide-lid-old-conversations-design.md)

---

## File Structure

| File | Responsibility | Change Type |
|---|---|---|
| `src/controllers/conversations.controller.js` | `cleanCustomerPhone` masks `@lid` sender to `عميل ····XXXX` | Modify |
| `src/workers/escalation-routing.js` | `cleanCustomerJid` applies same masking for escalation messages | Modify |
| `dashboard/index.html` | Renders "قديمة" badge when `c.phoneNumber` is missing (2 locations) | Modify |
| `dashboard/conversations.css` | Adds `.old-badge` style | Modify |
| `tests/conversations-controller.test.js` | 3 new tests + 3 existing assertions updated | Modify |
| `tests/escalation-routing.test.js` | 1 new test + 1 existing assertion updated | Modify |

---

## Task 1: Mask @lid in `cleanCustomerPhone` (controller)

**Files:**
- Modify: `src/controllers/conversations.controller.js:12-22`
- Test: `tests/conversations-controller.test.js`

- [ ] **Step 1: Add 3 new failing tests at the end of the test file**

Open `tests/conversations-controller.test.js` and append (after line 180):

```js
test('cleanCustomerPhone masks @lid sender to "عميل ····XXXX" (last 4 digits)', () => {
  assert.equal(cleanCustomerPhone('276282495500304@lid'), 'عميل ····0304');
  assert.equal(cleanCustomerPhone('278571713060916@lid'), 'عميل ····0916');
});

test('cleanCustomerPhone returns "عميل قديم" when lid has no digits', () => {
  assert.equal(cleanCustomerPhone('@lid'), 'عميل قديم');
});

test('cleanCustomerPhone row form masks @lid sender when phone_number is null', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '276282495500304@lid' }),
    'عميل ····0304'
  );
});
```

- [ ] **Step 2: Run the new tests — confirm FAIL**

Run:
```
node --test tests/conversations-controller.test.js
```
Expected: FAIL on the 3 new tests (`expected 'عميل ····0304' to equal '276282495500304@lid'`). The existing tests on lines 16, 137, 147 will keep passing because they still expect the raw `xxx@lid`.

- [ ] **Step 3: Replace `cleanCustomerPhone` implementation**

In `src/controllers/conversations.controller.js`, replace the function body (lines 12-22) with:

```js
function cleanCustomerPhone(senderOrRow) {
  if (senderOrRow && typeof senderOrRow === 'object') {
    const pn = String(senderOrRow.phone_number || '').trim();
    if (pn) return `+${pn}`;
    return cleanCustomerPhone(senderOrRow.sender);
  }
  const raw = String(senderOrRow || '').trim();
  if (raw.endsWith('@lid')) {
    const digits = raw.replace(/@lid$/, '').replace(/[^\d]/g, '');
    const last4 = digits.slice(-4);
    return last4 ? `عميل ····${last4}` : 'عميل قديم';
  }
  const digits = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}
```

- [ ] **Step 4: Update the 3 existing tests that expected raw `xxx@lid`**

In `tests/conversations-controller.test.js`, update these 3 assertions:

**Line 16** (inside `'cleanCustomerPhone extracts readable WhatsApp phone numbers'`):
```js
// BEFORE: assert.equal(cleanCustomerPhone('278571713060916@lid'), '278571713060916@lid');
assert.equal(cleanCustomerPhone('278571713060916@lid'), 'عميل ····0916');
```

**Lines 134-143** (the `'cleanCustomerPhone falls back to sender behavior when phone_number is null'` test):
```js
test('cleanCustomerPhone falls back to sender behavior when phone_number is null', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '276282495500304@lid' }),
    'عميل ····0304'
  );
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '966500000000@s.whatsapp.net' }),
    '+966500000000'
  );
});
```

**Line 147** (inside `'cleanCustomerPhone preserves the string-only signature for backward compat'`):
```js
// BEFORE: assert.equal(cleanCustomerPhone('276282495500304@lid'), '276282495500304@lid');
assert.equal(cleanCustomerPhone('276282495500304@lid'), 'عميل ····0304');
```

- [ ] **Step 5: Run the full test file — confirm PASS**

Run:
```
node --test tests/conversations-controller.test.js
```
Expected: All tests PASS (including the 3 new ones and the 3 updated assertions).

- [ ] **Step 6: Commit**

```
git add src/controllers/conversations.controller.js tests/conversations-controller.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): mask @lid sender as "عميل ····XXXX" in conversations API

Old conversations (phone_number=NULL) now return a friendly masked label
("عميل ····0304") instead of "276282495500304@lid" through cleanCustomerPhone.
The customer's @lid is stable, so the last 4 digits give a per-customer
identity. Falls back to "عميل قديم" when the lid has no digits.

New conversations with phone_number remain "+966xxxxxxxxx" unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mask @lid in `cleanCustomerJid` (escalation)

**Files:**
- Modify: `src/workers/escalation-routing.js:79-85`
- Test: `tests/escalation-routing.test.js`

- [ ] **Step 1: Add failing test in `tests/escalation-routing.test.js`**

Replace the existing test at lines 126-135 (the one that currently asserts `text.includes('276282495500304@lid')`):

**BEFORE:**
```js
test('buildEscalationNotification falls back to sender when customerPhoneNumber is missing', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  // No phoneNumber → existing behavior: lid leaks through (acceptable for old conversations).
  assert.ok(text.includes('276282495500304@lid'));
});
```

**AFTER:**
```js
test('buildEscalationNotification masks @lid sender to "عميل ····XXXX" when customerPhoneNumber is missing', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  assert.ok(text.includes('عميل ····0304'), 'must include masked label, got: ' + text);
  assert.ok(!text.includes('@lid'), 'must NOT include raw lid');
});

test('buildEscalationNotification uses "عميل قديم" when @lid has no digits', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم' },
    customerSender: '@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  assert.ok(text.includes('عميل قديم'));
  assert.ok(!text.includes('@lid'));
});
```

- [ ] **Step 2: Run the test file — confirm FAIL**

Run:
```
node --test tests/escalation-routing.test.js
```
Expected: FAIL on the masking tests (`text` still contains `276282495500304@lid`).

- [ ] **Step 3: Update `cleanCustomerJid` in `src/workers/escalation-routing.js`**

Replace lines 79-85:

**BEFORE:**
```js
function cleanCustomerJid(sender, { phoneNumber } = {}) {
  const pn = String(phoneNumber || '').trim();
  if (pn) return `+${pn}`;
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  return cleanDigits(sender) || raw;
}
```

**AFTER:**
```js
function cleanCustomerJid(sender, { phoneNumber } = {}) {
  const pn = String(phoneNumber || '').trim();
  if (pn) return `+${pn}`;
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) {
    const digits = raw.replace(/@lid$/, '').replace(/[^\d]/g, '');
    const last4 = digits.slice(-4);
    return last4 ? `عميل ····${last4}` : 'عميل قديم';
  }
  return cleanDigits(sender) || raw;
}
```

- [ ] **Step 4: Run the test file — confirm PASS**

Run:
```
node --test tests/escalation-routing.test.js
```
Expected: All tests PASS, including the two updated/added tests.

- [ ] **Step 5: Commit**

```
git add src/workers/escalation-routing.js tests/escalation-routing.test.js
git commit -m "$(cat <<'EOF'
feat(escalation): mask @lid sender in owner notifications

Escalation messages to the team (buildEscalationNotification) now show
"عميل ····0304" instead of "276282495500304@lid" when the customer has
no extracted phone number. Same masking logic as the conversations
controller for consistency.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Dashboard "قديمة" badge

**Files:**
- Modify: `dashboard/index.html:2024` (card in list)
- Modify: `dashboard/index.html:2095` (panel header)
- Modify: `dashboard/conversations.css` (add `.old-badge` style)

- [ ] **Step 1: Add the CSS rule for `.old-badge`**

Open `dashboard/conversations.css` and append at the end of the file:

```css
.old-badge {
  font-size: 10px;
  background: #f1f5f9;
  color: #64748b;
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 6px;
  vertical-align: middle;
  font-weight: 600;
  direction: rtl;
}
```

- [ ] **Step 2: Update the card row to show the badge**

In `dashboard/index.html`, find line 2024:

**BEFORE:**
```html
          <div class="phone">${esc(c.phone||c.sender||'')}</div>
```

**AFTER:**
```html
          <div class="phone">${esc(c.phone||c.sender||'')}${!c.phoneNumber ? '<span class="old-badge">قديمة</span>' : ''}</div>
```

- [ ] **Step 3: Update the panel header to show the badge**

In `dashboard/index.html`, find line 2095:

**BEFORE:**
```html
    <div class="phone">${esc(conv.phone||conv.sender||'')}</div>
```

**AFTER:**
```html
    <div class="phone">${esc(conv.phone||conv.sender||'')}${!conv.phoneNumber ? '<span class="old-badge">قديمة</span>' : ''}</div>
```

- [ ] **Step 4: Syntax sanity check**

Run:
```
node -e "const fs = require('fs'); const html = fs.readFileSync('dashboard/index.html', 'utf8'); console.log('lines:', html.split('\\n').length); console.log('badges:', (html.match(/old-badge/g) || []).length);"
```
Expected output:
```
lines: 2594  (or close)
badges: 2
```

- [ ] **Step 5: Commit**

```
git add dashboard/index.html dashboard/conversations.css
git commit -m "$(cat <<'EOF'
feat(dashboard): "قديمة" badge for old conversations (no phone_number)

When a conversation has no phoneNumber (rows created before the Phase A
senderPn capture deployed), display a small "قديمة" badge beside the
masked customer label. Helps the store owner understand why those rows
don't have a phone number.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Full test suite sanity check

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

Run:
```
node --test "tests/*.test.js"
```
Expected: All tests pass. Total should match the pre-existing count plus the 3 new ones added in Task 1 and the 1 new one added in Task 2 (so +4 total).

Inspect output for:
- `# tests` count
- `# pass` should equal `# tests`
- `# fail` should be 0

- [ ] **Step 2: If any test fails, STOP and investigate**

Do not proceed to Task 5 if there are any failures. Read the failure message, identify whether it's a regression (something my change broke) or an unrelated pre-existing failure. If the latter, document it and pause for human review. If the former, fix the regression and re-run from Step 1.

---

## Task 5: PR + merge + Railway deploy

**Files:** none (deployment only)

- [ ] **Step 1: Verify branch and review staged work**

Run:
```
git status
git log master..HEAD --oneline
```
Expected: 3 commits ahead of master (Task 1, Task 2, Task 3 commits).

- [ ] **Step 2: Push branch to origin**

Run:
```
git push -u origin claude/amazing-galileo-e47eaf
```
Expected: Branch pushed successfully.

- [ ] **Step 3: Create PR**

Run:
```
gh pr create --title "feat: hide @lid in old conversations + escalation notifications" --body "$(cat <<'EOF'
## Summary
- Replace raw `xxx@lid` with `عميل ····XXXX` (last 4 digits) in conversations API
- Apply same masking to escalation notifications sent to team members
- Add "قديمة" badge in dashboard for conversations missing `phone_number`

## Why
Phase A ([PR #15](https://github.com/sahiniksa-cyber/raddi-bot/pull/15)) captures `senderPn` for new messages, but conversations created before the deploy have `phone_number = NULL`. Without this PR, those old conversations show ugly raw lid identifiers like `276282495500304@lid` in both the dashboard and escalation messages.

## What changed
- `src/controllers/conversations.controller.js` — `cleanCustomerPhone` now masks `@lid`
- `src/workers/escalation-routing.js` — `cleanCustomerJid` applies the same masking
- `dashboard/index.html` — "قديمة" badge appears when `c.phoneNumber` is missing
- `dashboard/conversations.css` — new `.old-badge` style
- Tests updated and 4 new tests added

## What did NOT change
- DB schema, AI client, queues, Baileys stack — all untouched
- Existing `phone_number` flow keeps working (new conversations → `+966xxxxxxxxx`)
- API contract — same fields, only the `phone` string content differs for `@lid` rows

## Test plan
- [x] `node --test "tests/*.test.js"` passes locally
- [ ] After Railway deploy, verify dashboard shows masked label + badge on old conversations
- [ ] After Railway deploy, verify new (post-Phase-A) conversations still show `+966...` without badge
- [ ] Trigger an escalation from an old @lid customer → owner receives "عميل ····XXXX"

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI (if any) and merge**

Run:
```
gh pr view --json url
gh pr merge --squash --delete-branch
```
Expected: PR merged into master.

⚠️ If `--delete-branch` fails locally because the worktree uses the branch, ignore that local error — the remote merge is what matters. Run `gh pr view` afterwards to confirm `state: MERGED`.

- [ ] **Step 5: Verify Railway deploy**

After ~2-3 minutes:
```
gh api repos/sahiniksa-cyber/raddi-bot/commits/master --jq '.sha'
```
Compare against Railway's latest deploy SHA in the Railway dashboard. They should match.

Then verify in the live dashboard:
1. Open https://jwap.net (or actual production URL) → conversations view
2. Scroll to an old conversation → confirm it shows `عميل ····XXXX` with `قديمة` badge
3. Scroll to a new conversation (created after Phase A) → confirm it shows `+966...` without badge

---

## Self-Review

### 1. Spec coverage
- ✅ `cleanCustomerPhone` masking → Task 1
- ✅ `cleanCustomerJid` masking for escalation → Task 2
- ✅ Dashboard badge in list card → Task 3 (Step 2)
- ✅ Dashboard badge in panel header → Task 3 (Step 3)
- ✅ CSS for badge → Task 3 (Step 1)
- ✅ Tests for masking → Task 1 (Step 1) + Task 2 (Step 1)
- ✅ Tests for "عميل قديم" fallback → Task 1 (Step 1) + Task 2 (Step 1)
- ✅ Tests for backwards-compat (`phone_number` still wins) → existing test on line 127, unchanged
- ✅ Existing tests updated → Task 1 (Step 4) + Task 2 (Step 1, the rewritten test)

### 2. Placeholder scan
- No "TBD", "TODO", "similar to", or vague "handle edge cases" wording in any task.
- Every code step shows the actual code to write.
- Every command step shows the exact command and expected output.

### 3. Type consistency
- `cleanCustomerPhone` and `cleanCustomerJid` produce the same string format (`عميل ····XXXX` or `عميل قديم`) — verified across Task 1 and Task 2.
- The masking regex `/[^\d]/g` is identical in both functions.
- The slice `.slice(-4)` is consistent.
- The dashboard badge condition `!c.phoneNumber` matches the payload field name in [src/controllers/conversations.controller.js:141](src/controllers/conversations.controller.js:141) (`phoneNumber: row.phone_number || null`).

Plan is consistent and complete.
