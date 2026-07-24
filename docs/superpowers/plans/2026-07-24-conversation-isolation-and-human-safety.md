# Conversation Isolation and Human Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and enforce tenant/conversation isolation, at-most-once processing, grounded replies, and real human handoff at the WhatsApp send boundary.

**Architecture:** Keep the existing `user_id`/`sender` domain model, add defense-in-depth database and worker validation, and fail closed at Redis/AI trust boundaries. Preserve the existing two-stage quality gate while turning its unsafe outcomes into an idempotent handoff.

**Tech Stack:** Node.js 20, PostgreSQL, BullMQ/Redis, OpenAI-compatible chat API, `node:test`.

## Global Constraints

- Preserve existing uncommitted work in AI context and quality-gate files.
- Do not commit, switch branches, or deploy.
- Every production-code fix starts with a failing regression test.
- No customer content may be selected by `conversation_id` without `user_id`.
- No outbound payload may be sent before database scope validation.

---

### Task 1: Inbound idempotency and deterministic ordering

**Files:**
- Modify: `src/services/whatsapp/message-ingest.service.js`
- Modify: `src/workers/ai-history.js`
- Modify: `src/workers/ai-worker.js`
- Test: `tests/message-ingest-idempotency.test.js`
- Test: `tests/ai-history.test.js`

**Interfaces:**
- `insertInboundMessage(...) -> { id, inserted }`
- `ingestWhatsappMessage(...) -> reason: "duplicate_provider_message"` for duplicates

- [ ] Write a concurrent duplicate-delivery test that expects one AI enqueue.
- [ ] Run the targeted test and confirm it fails because both deliveries enqueue.
- [ ] Change the insert to `ON CONFLICT DO NOTHING`, load the existing scoped row, and skip enqueue for duplicates.
- [ ] Add `(created_at, id)` ordering to history/pending-message reads.
- [ ] Run targeted tests and confirm they pass.

### Task 2: Mandatory tenant scope and database invariants

**Files:**
- Modify: `src/workers/ai-history.js`
- Modify: `src/workers/profile-extractor.js`
- Modify: `src/workers/reply-deduplication.js`
- Modify: `src/db/migrations/init.js`
- Test: `tests/conversation-scope-enforcement.test.js`

**Interfaces:**
- History/profile/dedup reads require `userId`.
- New composite foreign keys bind messages to `(conversation_id, user_id, sender)`.

- [ ] Write tests that reject missing tenant scope and inspect migration invariants.
- [ ] Run them and confirm the optional-filter behavior fails the test.
- [ ] Make tenant filtering unconditional and add stable ordering.
- [ ] Add parent unique and child `NOT VALID` composite foreign-key constraints so new writes are protected without destructive cleanup.
- [ ] Run targeted tests and confirm they pass.

### Task 3: Outgoing payload binding and atomic state ownership

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Modify: `src/services/ai/pre-send-review.js`
- Test: `tests/outgoing-scope-binding.test.js`
- Test: `tests/pre-send-review.test.js`

**Interfaces:**
- `validateOutgoingScope(...)` returns the authoritative stored row or throws `OUTGOING_SCOPE_MISMATCH`.
- Message updates require `user_id` and, when available, `conversation_id`.

- [ ] Write a test with a tenant-correct message ID but wrong conversation/customer and assert no send.
- [ ] Run it and confirm the current payload is trusted.
- [ ] Validate the message/conversation tuple before bot lookup or review and use the database reply as source of truth.
- [ ] Scope every outgoing message read/update and final-review lookup.
- [ ] Run targeted tests and confirm they pass.

### Task 4: Cross-customer memory isolation and 20-client proof

**Files:**
- Modify: `src/services/learning/owner-reply-learner.js`
- Modify: `src/workers/ai-worker.js`
- Modify: `.env.example`
- Test: `tests/conversation-isolation-20-clients.test.js`
- Test: `tests/owner-reply-learner.test.js`

**Interfaces:**
- `LEARNED_REPLIES_INJECTION_ENABLED=true` is required for cross-customer learned-answer injection; default is false.

- [ ] Write a 20-client concurrent context/review test with a unique secret per client.
- [ ] Write a test proving learned replies are not loaded by default.
- [ ] Run and confirm the learned-memory test fails under the current default-on behavior.
- [ ] Add the explicit reuse gate and document it.
- [ ] Run targeted tests and confirm no secret appears outside its own context.

### Task 5: Confidence-aware final review and real handoff

**Files:**
- Modify: `src/services/ai/reply-quality-gate.js`
- Modify: `src/services/ai/pre-send-review.js`
- Modify: `src/workers/outgoing-whatsapp-worker.js`
- Test: `tests/pre-send-human-handoff.test.js`
- Test: `tests/reply-quality-gate.test.js`

**Interfaces:**
- Final review audit includes `confidence`, `requiresHuman`, `humanReason`, and `handoffSummary`.
- The outgoing worker parses any final transfer marker and enqueues one team-facing escalation job before sending the clean customer acknowledgement.

- [ ] Write failing tests for refund, payment failure, explicit employee request, low confidence, and a literal transfer-marker leak.
- [ ] Extend review JSON parsing and deterministic mandatory-handoff detection.
- [ ] Route the final marker through `prepareEscalation`, enqueue with a deterministic key, and strip it from customer text.
- [ ] Run targeted tests and confirm all handoff cases pass without duplicate sends.

### Task 6: Verification and report

**Files:**
- Create: `docs/security/2026-07-24-conversation-isolation-audit.md`

- [ ] Run all targeted security tests.
- [ ] Run `npm test` and record pass/fail totals.
- [ ] Re-scan message SQL, queue keys, and global maps for unscoped customer data.
- [ ] Record critical/medium/minor findings, root causes, exact file/line references, fixes, and residual production validation requirements.
