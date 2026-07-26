# Safe Reply Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, tenant-isolated reply pipeline that binds every commercial claim to one versioned product plan and cannot send an unvalidated or forbidden response.

**Architecture:** Normalize merchant products into a versioned fact catalog, resolve product focus from the current session, answer catalog questions deterministically, and run a fail-closed final validator after every repair. Store redacted stage traces and catalog versions, while keeping human escalation independent from factual validation.

**Tech Stack:** Node.js 20+, PostgreSQL JSONB, BullMQ/Redis, `node:test`, existing Express/Baileys runtime.

## Global Constraints

- No production deployment or production data mutation.
- Work only on `codex/safe-reply-hardening` in the isolated worktree.
- Every production-code change must follow RED → GREEN → refactor.
- Preserve tenant/channel/conversation/customer scope in every DB query and queue payload.
- LLM decisions cannot override deterministic validation.
- Migrations must be additive and include explicit down SQL documentation.
- No skipped or disabled tests.

---

### Task 1: Product fact catalog and focus resolver

**Files:**
- Create: `src/services/products/product-facts.js`
- Modify: `src/services/products/product-knowledge.js`
- Test: `tests/product-facts.test.js`
- Test: `tests/product-knowledge.test.js`

**Interfaces:**
- Produces `buildProductFactCatalog(config, { catalogVersion })`.
- Produces `resolveProductFocus({ catalog, history, customerText })`.
- Produces `buildScopedProductContext({ catalog, focus })`.

- [x] Write tests proving Adobe resolves from a generic duration follow-up, multiple explicit products are ambiguous, aliases stay attached to one product, and only selected products enter context.
- [x] Run the tests and verify failures are caused by the missing APIs/current all-catalog behavior.
- [x] Implement normalized product/plan IDs, Arabic/English aliases, duration and currency parsing, and ordered focus resolution.
- [x] Run product tests and the existing prompt tests.
- [x] Commit the isolated task.

### Task 2: Tuple-level commercial claim validator

**Files:**
- Create: `src/services/ai/product-claim-validator.js`
- Modify: `src/services/ai/reply-quality-gate.js`
- Test: `tests/product-claim-validator.test.js`
- Test: `tests/reply-quality-gate.test.js`

**Interfaces:**
- Consumes the fact catalog and focus from Task 1.
- Produces `extractCommercialClaims(reply, context)`.
- Produces `validateCommercialClaims(reply, { catalog, focus })`.
- Produces `buildDeterministicCatalogReply({ customerText, focus, catalog })`.

- [x] Write failing tests for Adobe 6/89, Adobe year/139, stale Adobe 8/289, unavailable plans, cross-product prices, correct Adobe 4/189 and 8/319, and ambiguous questions.
- [x] Verify every unsafe case passes incorrectly or lacks an implementation on the baseline.
- [x] Implement tuple matching on productId, planId, duration, amount, currency, and availability.
- [x] Replace global `configuredPriceValues` acceptance for product claims with tuple validation.
- [x] Re-run all product and quality-gate tests.
- [x] Commit the isolated task.

### Task 3: Deterministic repair and final validation loop

**Files:**
- Create: `src/services/ai/final-reply-pipeline.js`
- Modify: `lib/ai-client.js`
- Modify: `src/services/ai/pre-send-review.js`
- Test: `tests/final-reply-pipeline.test.js`
- Test: `tests/pre-send-review.test.js`

**Interfaces:**
- Produces `finalizeReply({ draft, history, customerText, config, catalogVersion })`.
- Returns `{ decision, reply, claims, focus, stages, reason }`.

- [x] Write failing tests showing a reviewer repair cannot clear earlier violations, repaired text is revalidated, one repair is the maximum, and unresolved commercial facts become clarification rather than guesses.
- [x] Verify RED.
- [x] Implement deterministic precedence and one bounded repair followed by a complete second validation.
- [x] Make pre-send require `decision === 'validated'` before returning sendable text.
- [x] Re-run AI client, pre-send, and quality tests.
- [x] Commit the isolated task.

### Task 4: Forbidden language and optional employee identity

**Files:**
- Modify: `lib/post-process-reply.js`
- Modify: `lib/ai-client.js`
- Modify: `src/services/bot/platform-features.js`
- Modify: `lib/constants.js`
- Test: `tests/post-process-reply.test.js`
- Test: `tests/ai-identity.test.js`

**Interfaces:**
- Produces `effectiveAvoidList(config)`.
- Produces `scanForbiddenContent(reply, config)`.

- [ ] Restore failing tests for `avoidWords`, `avoidPhrases`, punctuation variants, Arabic/English identity disclosure, and empty-after-filter behavior.
- [ ] Add failing tests proving merchant lists merge with defaults and employee names are absent unless `employeeNameEnabled`.
- [ ] Verify RED.
- [ ] Implement merged normalized filtering and optional employee identity.
- [ ] Re-run prompt, post-process, style, and escalation privacy tests.
- [ ] Commit the isolated task.

### Task 5: Enforced reply length and non-silent duplicate handling

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Modify: `src/services/ai/reply-quality-gate.js`
- Modify: `src/workers/ai-worker.js`
- Test: `tests/reply-length-policy.test.js`
- Test: `tests/reply-duplicate-non-silent.test.js`

**Interfaces:**
- Produces `enforceReplyBudget(reply, policy, protectedFacts)`.
- Produces `resolveDuplicateReply({ draft, history, customerText })`.

- [ ] Write failing tests for character/sentence/line limits, URL/fact preservation, and revalidation after shortening.
- [ ] Write failing tests for repeated greeting, price, question, exact/semantic duplicate, and retry without a new customer turn.
- [ ] Verify RED.
- [ ] Implement bounded sentence-aware shortening and distinguish duplicate send from a new customer turn.
- [ ] Ensure a new turn receives a safe response or clarification, while idempotent retry may suppress.
- [ ] Re-run validator, deduplication, worker, and pre-send tests.
- [ ] Commit the isolated task.

### Task 6: Catalog version history

**Files:**
- Modify: `src/db/migrations/init.js`
- Create: `src/services/products/catalog-version-repository.js`
- Modify: `src/controllers/config.controller.js`
- Modify: `src/services/bot/runtime-bot.js`
- Modify: `src/services/prompt-edit/prompt-edit.service.js`
- Test: `tests/catalog-version-migration.test.js`
- Test: `tests/catalog-version-repository.test.js`
- Add: `docs/migrations/rollback-product-catalog-versions.sql`

**Interfaces:**
- Produces `saveCatalogVersion({ database, scope, products, actor, reason })`.
- Produces `loadCatalogVersion({ database, tenantId, version })`.

- [ ] Write failing schema and repository tests for immutable monotonic versions, before/after snapshots, actor/time/reason, and concurrent updates.
- [ ] Verify RED.
- [ ] Add the version table, indexes, trigger/fallback source metadata, repository, and all config-write integrations.
- [ ] Record catalog version in runtime config resolution.
- [ ] Re-run migrations and config-save tests.
- [ ] Commit the isolated task.

### Task 7: Redacted reply-stage audit

**Files:**
- Modify: `src/db/migrations/init.js`
- Create: `src/services/ai/reply-trace-repository.js`
- Modify: `src/workers/ai-worker.js`
- Modify: `src/services/ai/pre-send-review.js`
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Test: `tests/reply-trace-repository.test.js`
- Test: `tests/reply-trace-integration.test.js`
- Add: `docs/migrations/rollback-ai-reply-traces.sql`

**Interfaces:**
- Produces `startReplyTrace(scope, input)`, `appendReplyStage(operationId, stage)`, and `finishReplyTrace(operationId, outcome)`.

- [ ] Write failing tests for all required stages, scope fields, versions, timings, redaction, retention metadata, and no API secrets.
- [ ] Verify RED.
- [ ] Add additive schema and repository with 30-day default retention.
- [ ] Wire generation, quality review, repair, duplicate review, final validation, queueing, block, and send outcomes.
- [ ] Re-run worker and pre-send integration tests.
- [ ] Commit the isolated task.

### Task 8: Tenant isolation, concurrency, and idempotency

**Files:**
- Modify: `src/services/whatsapp/message-ingest.service.js`
- Modify: `src/queues/message-queue.js`
- Modify: `src/workers/ai-worker.js`
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Test: `tests/multi-tenant-reply-isolation.test.js`
- Test: `tests/message-idempotency-e2e.test.js`
- Test: `tests/reply-concurrency.test.js`

**Interfaces:**
- Uses the existing scope tuple everywhere.
- Produces a stable inbound processing key derived from tenant, channel, conversation, customer, and provider message ID.

- [ ] Write failing 20-customer/multi-tenant secret-isolation simulation and concurrent same-product/different-price tests.
- [ ] Write failing duplicate webhook, retry, delayed message, worker restart, and double-send tests.
- [ ] Verify RED for uncovered cases and document already-passing guards.
- [ ] Add only the missing scope/idempotency checks; preserve existing working guards.
- [ ] Re-run ingest, queue, worker, outgoing, billing, and isolation tests.
- [ ] Commit the isolated task.

### Task 9: Failure-state machine and shadow simulation

**Files:**
- Create: `src/services/ai/reply-state-machine.js`
- Create: `scripts/simulate-safe-replies.js`
- Modify: `src/workers/ai-worker.js`
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Modify: `.env.example`
- Test: `tests/reply-state-machine.test.js`
- Test: `tests/safe-reply-simulation.test.js`

**Interfaces:**
- Produces explicit transitions among `received`, `processing`, `generated`, `validated`, `blocked`, `queued_for_send`, `sent`, `failed`, and `escalated`.
- Simulation emits JSON summary with scenario counts and exact assertion results.

- [ ] Write failing transition and failure-injection tests for provider timeout, empty/invalid JSON, DB/Redis failure, quality failure, send/register split failures, retry, restart, and stale messages.
- [ ] Verify RED.
- [ ] Implement legal transitions and gate send on validated state.
- [ ] Implement a no-send simulation covering all required product, ambiguity, concurrency, retry, webhook, stale-message, and price-change scenarios.
- [ ] Re-run failure and simulation tests.
- [ ] Commit the isolated task.

### Task 10: Full verification and release package

**Files:**
- Add: `docs/release/safe-reply-rollout.md`
- Add: `docs/audits/2026-07-26-safe-reply-final-report.md`

**Interfaces:**
- Consumes all test and simulation outputs.

- [ ] Run focused tests after each task and save exact commands/results.
- [ ] Run `npm test` with production endpoints disabled.
- [ ] Run the simulation in shadow/no-send mode and capture counts, blocked reasons, and accuracy.
- [ ] Review migrations forward/down and confirm no production connection or deployment occurred.
- [ ] Document feature flags, shadow mode, test merchant rollout, monitoring, progressive rollout, and rollback.
- [ ] Produce the requirement → fix → test matrix and important diffs.
- [ ] Commit the release documentation.
