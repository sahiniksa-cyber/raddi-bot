# Campaign Worker Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion while executing each task.

**Goal:** Make campaign delivery crash-safe, stop-safe, retry-safe, and tenant-isolated without Redis, WhatsApp, or production services in tests.

**Architecture:** Exercise the real `processCampaignRecipient()` and `recoverCampaignDeliveries()` functions against a deterministic transactional repository fake and an idempotent transport fake. Keep the production change inside the campaign worker: perform the recipient charge marker and billing debit in one database transaction, and re-read the locked campaign status immediately before every network send.

**Tech Stack:** Node.js 20 test runner, CommonJS, PostgreSQL-shaped deterministic repository fake, BullMQ-shaped in-memory queue.

## Global Constraints

- Do not modify `campaign-service.js`, `campaign.routes.js`, the billing Excel ledger, spreadsheet adapter, package manifests, or ExcelJS.
- Use only deterministic local fakes; never contact PostgreSQL, Redis, WhatsApp, or production credentials.
- Preserve exact message bytes, recipient identity, campaign identity, merchant identity, idempotency keys, quota, and status.
- Same-merchant admission reservation is deferred because it requires `campaign-service.js`.

---

### Task 1: Atomic recipient quota charge

**Files:**
- Modify: `src/workers/campaign-worker.js`
- Create: `tests/integration/campaign-worker-safety.test.js`
- Create: `tests/helpers/campaign-worker-runtime.js`

**Interfaces:**
- Consumes: a database exposing `query(text, params)` and `transaction(callback)`.
- Produces: `decrementCampaignRecipientQuota({ database, userId, recipientId }) -> { success, remaining?, alreadyDebited? }`.

- [ ] Write a failing test that injects a crash at transaction commit and proves both the billing debit and `quota_decremented` marker roll back, then retries the same job and observes one debit.
- [ ] Run `node --test tests/integration/campaign-worker-safety.test.js --test-name-pattern="quota debit"` and verify failure because the debit and marker are currently separate.
- [ ] Add a single transaction that locks the recipient, conditionally debits the merchant account, and marks that recipient before commit.
- [ ] Re-run the focused test and verify it passes.

### Task 2: Final campaign status fence

**Files:**
- Modify: `src/workers/campaign-worker.js`
- Modify: `tests/integration/campaign-worker-safety.test.js`
- Modify: `tests/helpers/campaign-worker-runtime.js`

**Interfaces:**
- Produces: a delivery fence that returns `send`, `paused`, or `canceled` after locking the current campaign and recipient.

- [ ] Write failing pause and cancel barrier tests that change campaign status after the worker's initial recipient lock but before transport.
- [ ] Run the focused tests and verify the current worker transports despite the new status.
- [ ] Add a locked final status read immediately before every media or text gateway call; restore `sending` to `pending` for pause and to `canceled` for cancel without counting a failure.
- [ ] Re-run the focused tests and verify no transport occurs.

### Task 3: Retry, duplicate, restart, partial progress, and isolation matrix

**Files:**
- Modify: `tests/integration/campaign-worker-safety.test.js`
- Modify: `tests/helpers/campaign-worker-runtime.js`

**Interfaces:**
- The runtime persists campaigns, recipients, quotas, media cursors, text markers, reservations, messages, and queue jobs across worker recreation.

- [ ] Add literal-expectation tests for duplicate job replay, media cursor restart, text marker restart, two campaigns for one merchant, and two merchants.
- [ ] Run each test before any additional production adjustment and record whether it is RED for a real worker gap or GREEN as coverage of existing behavior.
- [ ] For any RED worker gap, make only the smallest worker/recovery change after identifying its root cause.
- [ ] Verify exact text bytes, ordered media bytes, idempotency keys, provider IDs, quota changes, and terminal counts.

### Task 4: Verification, report, and commit

**Files:**
- Create: `.superpowers/task5-worker-safety-report.md`

- [ ] Run the focused worker safety test file.
- [ ] Run existing campaign, quota, and gateway tests affected by the worker.
- [ ] Inspect `git diff --check`, `git status`, and the final diff for prohibited files.
- [ ] Document RED/GREEN evidence, exact commands, conflicts, and deferred admission/cross-campaign policy gaps.
- [ ] Commit only the worker-safety files on `codex/campaign-lifecycle-parallel`.
