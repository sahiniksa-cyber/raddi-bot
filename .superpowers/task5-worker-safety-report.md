# Task 5 Worker Safety Report

## Outcome

Campaign delivery now protects the two worker-side crash/race boundaries identified by the Task 5 coverage inventory:

1. Billing debit and `campaign_recipients.quota_decremented` are committed in one database transaction after locking the tenant-owned recipient. A failure after the billing update rolls the debit back with the marker.
2. Every media and text transport has a final locked campaign/recipient status fence. A committed pause restores the in-flight recipient to `pending`; a committed cancel marks it `canceled`; neither path transports, bills, inserts an outbound message, or increments campaign counts.

Recovery also accepts an injected clock for exact deterministic delayed scheduling without changing the production default (`Date.now`).

No migration or package change was needed.

## TDD evidence

The implementation was test-first:

- Atomic helper RED: `decrementCampaignRecipientQuota is not a function`.
- Worker atomicity RED: after an injected crash before the recipient marker, quota was incorrectly persisted as `{ messages_remaining: 1, messages_used: 1 }` instead of rolling back to `{ 2, 0 }`.
- Pause/cancel RED: both barrier cases returned `{ sent: true }` after status changed between the initial worker lock and transport.
- Frozen recovery clock RED: the future job delay was `3644998` ms instead of the literal `45000` ms.

Each RED was followed by the smallest production change and a focused GREEN run.

## New deterministic coverage

`tests/integration/campaign-worker-safety.test.js` runs the real campaign worker/recovery functions with local PostgreSQL- and BullMQ-shaped fakes:

- quota debit + recipient marker rollback and exactly-once retry;
- worker integration of the atomic quota path;
- pause and cancel after initial worker lock, before text transport;
- restart after media transport but before `media_cursor`, followed by restart after text transport but before `text_sent`;
- durable idempotency keys:
  - `campaign:<campaign>:<recipient>:media:<index>`
  - `campaign:<campaign>:<recipient>:text`
- exact media buffers and exact text bytes across retries;
- stale `sending`, missing queued job, retained live job, partial progress, terminal row, and exact future schedule recovery;
- two active campaigns for one merchant, including the same destination in both campaigns;
- two merchants with destination, text, tenant scope, quota, message, and result isolation;
- duplicate terminal job replay with no second transport or debit;
- two same-merchant campaigns whose combined recipients exceed quota: one send, one deterministic quota pause, never negative.

Focused result:

```text
node --test tests/integration/campaign-worker-safety.test.js
9 tests, 9 pass, 0 fail
```

Related regression result:

```text
node --test tests/campaigns.test.js tests/message-quota.test.js tests/whatsapp/campaign-send-gateway.test.js tests/whatsapp/send-gateway-idempotency.test.js
64 tests, 64 pass, 0 fail
```

Full repository result:

```text
npm test
1616 tests, 1615 pass, 1 fail
```

The sole failure is the pre-existing, unrelated mutation probe
`tests/mutation/critical-guards.test.js`: mutant `audit-before-network`
survived. The worker-safety changes do not modify the audited gateway,
mutation runner, or its probe, and the directly related gateway regression
tests above pass.

## Files changed

- `src/workers/campaign-worker.js`
- `tests/helpers/campaign-worker-runtime.js`
- `tests/integration/campaign-worker-safety.test.js`
- `.superpowers/task5-worker-safety-plan.md`
- `.superpowers/task5-worker-safety-report.md`

No prohibited Task 4 files were modified.

## Conflicts and deferred gaps

- No merge conflict was encountered in the isolated `codex/campaign-lifecycle-parallel` worktree.
- The full-suite `audit-before-network` mutation survivor is unrelated and remains unresolved because its files are outside this task's authorized scope.
- Same-merchant campaign admission remains best-effort. The conditional worker debit prevents negative/over-used quota and deterministically pauses the later campaign, but reserving quota when starting multiple campaigns requires changes to `campaign-service.js`, which was explicitly outside this worker-safety scope.
- Cross-campaign recipient deduplication remains intentionally absent. The new test makes the existing policy explicit: the same destination may receive two separately approved campaigns, with campaign-specific idempotency keys and independent results.
- Upload parsing, corrupt/spoofed input handling, HTTP authorization, and full dashboard/status-log reconciliation belong to the non-worker portions of Task 5 and were not changed here.
