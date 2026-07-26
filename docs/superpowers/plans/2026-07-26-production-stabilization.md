# Production Stabilization Sprint — TDD Implementation Plan

> **Execution rule:** Complete each task in RED → implementation → GREEN →
> mutation-kill order. Do not write the implementation slice before its RED
> evidence is recorded.

**Goal:** Replace optional, distributed, partly probabilistic reply authorization
with one canonical merchant policy and one deterministic, audited, fail-closed
WhatsApp send gateway.

**Architecture:** `bot_configs.config.merchantPolicy` is the only merchant-owned
runtime truth. A versioned platform policy supplies non-overridable safety
invariants. LLMs produce drafts and advisory diagnostics only. Every WhatsApp
send class crosses one gateway; only one transport adapter may call
`client.sendMessage`.

**Tech stack:** Node.js CommonJS, PostgreSQL JSONB, BullMQ, Baileys, Node test
runner.

**Official spec:**
`docs/superpowers/specs/2026-07-26-production-stabilization-design.md`

**Baseline evidence:** `docs/stabilization/baseline-2026-07-26.md` and
`docs/stabilization/baseline-2026-07-26.tap`

## Global Execution Constraints

- Local worktree only; do not call production services or Railway.
- Never use a real OpenAI, Redis, PostgreSQL, or WhatsApp credential in tests.
- Tests use fakes, fixtures, local pure modules, or an explicitly local database.
- Do not use `botInstructions` at runtime after the policy cutover.
- Do not add a silent fallback to legacy config.
- Do not add a second policy store.
- Do not let any LLM authorize sending.
- Do not alter human-authored wording without explicit policy.
- Do not accept a migration without tested rollback and preservation behavior.
- If a claimed protection survives its disabling mutation, stop.
- Commit after each coherent GREEN slice.

## Root Cause to RED Matrix

| Root cause | First RED test | Baseline expectation | GREEN proof |
| --- | --- | --- | --- |
| RC-01 multiple fact sources | `tests/architecture/single-policy-source.test.js` | Finds product/price reads outside compiler | Runtime reads only compiled policy |
| RC-02 executable `botInstructions` | `tests/policy/no-runtime-bot-instructions.test.js` | Finds runtime references | Only migrator/archive/UI compatibility references remain |
| RC-03 optional final gate | `tests/architecture/mandatory-send-gateway.test.js` | Finds optional `preSendReviewRequired` authorization | Producers cannot bypass gateway |
| RC-04 multiple send sites | `tests/architecture/single-whatsapp-transport.test.js` | Finds direct send sites | Only transport adapter calls client |
| RC-05 LLM safety authority | `tests/ai/llm-cannot-authorize.test.js` | Reviewer can influence route/pass | Deterministic result always wins |
| RC-06 unbound numeric evidence | `tests/ai/product-bound-grounding.test.js` | Product A number can ground B | Exact product/variant evidence required |
| RC-07 fail-open dependencies | `tests/whatsapp/send-gateway-fail-closed.test.js` | Some failures still send | Zero transport calls on every failure |
| RC-08 stale send policy | `tests/whatsapp/policy-change-before-send.test.js` | Cached old price may pass | Latest DB policy blocks/repairs |
| RC-09 missing stage audit | `tests/audit/reply-audit-chain.test.js` | No complete chain | Original, transforms, decision, attempt, result reconstruct |
| RC-10 forbidden restore | restored `tests/post-process-reply.test.js` cases | Short clean may return original | Never reintroduces removed content |
| RC-11 removed regressions | `tests/regressions/revert-70f9fd1.test.js` plus restored cases | Selected incidents fail | Useful guards green without false handoff |
| RC-12 wiring-only tests | `tests/mutation/critical-guards.test.js` | Disabled guards may escape | Every listed mutant is killed |
| RC-13 narrow simulation | `tests/simulation/stabilization-simulation.test.js` | Harness absent | Seeded critical matrix ≥10,000 green |

---

## Task 1: Lock Architectural Invariants With RED Tests

**Create:**

- `tests/architecture/single-policy-source.test.js`
- `tests/architecture/single-whatsapp-transport.test.js`
- `tests/architecture/mandatory-send-gateway.test.js`
- `tests/helpers/source-architecture.js`
- `docs/stabilization/red-green-ledger.md`

**Scan scope:** `lib/`, `src/`, `dashboard/`, and `scripts/`; exclude tests,
documentation, legacy archives, and the dedicated migration module.

### Step 1.1 — Write RED source-boundary tests

`single-policy-source.test.js` must fail while these runtime reads exist:

- `lib/ai-client.js` reads `config.botInstructions`;
- product knowledge parses `botInstructions`;
- quality gate concatenates `botInstructions`;
- escalation routing parses contacts from `botInstructions`;
- prompt edit writes executable `botInstructions`.

The test allows the token only in:

- dashboard compatibility import/export;
- the legacy migrator;
- migration fixtures;
- tests and documentation.

`single-whatsapp-transport.test.js` scans AST-independent call patterns and
allows `client.sendMessage`/`sock.sendMessage` only in
`src/services/whatsapp/whatsapp-transport-adapter.js`.

`mandatory-send-gateway.test.js` asserts:

- every producer imports/invokes `WhatsAppSendGateway`;
- no producer uses `preSendReviewRequired` as an authorization switch;
- gateway request construction contains an explicit `sendClass`,
  `policyVersion`, `idempotencyKey`, and tenant scope.

### Step 1.2 — Run and record RED

```powershell
node --test tests/architecture/single-policy-source.test.js tests/architecture/single-whatsapp-transport.test.js tests/architecture/mandatory-send-gateway.test.js
```

Expected: all three fail and enumerate current violations. Record exact failing
assertions and counts in `docs/stabilization/red-green-ledger.md`.

No production code changes occur in Task 1.

### Step 1.3 — Commit RED architecture tests

```powershell
git add -- tests/architecture tests/helpers/source-architecture.js docs/stabilization/red-green-ledger.md
git commit -m "test: expose distributed policy and send bypasses"
```

---

## Task 2: Canonical Policy Schema, Compiler, and Legacy Migration

**Create:**

- `src/policy/platform-reply-policy.js`
- `src/policy/merchant-policy-schema.js`
- `src/policy/merchant-policy-compiler.js`
- `src/policy/merchant-policy-migrator.js`
- `tests/policy/merchant-policy-schema.test.js`
- `tests/policy/merchant-policy-compiler.test.js`
- `tests/policy/merchant-policy-migrator.test.js`
- `tests/policy/policy-version.test.js`
- `tests/fixtures/policy/*.json`

**Modify after RED only:**

- `lib/constants.js`

### Step 2.1 — RED schema and version tests

Assert:

- all required sections exist;
- `status` is one of `active`, `needs_review`, `invalid`;
- prices use integer minor units and explicit currency;
- stable IDs are unique;
- instant replies reference existing evidence IDs;
- routing rules reference existing contacts;
- canonical hashing is stable across object-key order;
- changing a fact changes `policyVersion`;
- callers cannot supply a forged `policyVersion`.

Run:

```powershell
node --test tests/policy/merchant-policy-schema.test.js tests/policy/policy-version.test.js
```

Expected RED: modules do not exist.

### Step 2.2 — Implement schema and canonical versioning

Use explicit validation functions; do not add an LLM or prose parser. Return a
typed result:

```js
{ ok: true, policy, policyVersion }
// or
{ ok: false, status: 'invalid', errors: [{ path, code }] }
```

`compileMerchantPolicy` returns immutable indexes by product ID, alias, variant
ID, business-rule ID, contact ID, and instant-reply ID. It never reads global
config.

### Step 2.3 — GREEN schema/compiler

```powershell
node --test tests/policy/merchant-policy-schema.test.js tests/policy/merchant-policy-compiler.test.js tests/policy/policy-version.test.js
```

### Step 2.4 — RED legacy migration tests

Fixtures must cover:

- fully structured products/persona/prohibitions/routing;
- exact `autoReplyKeywords` mapping;
- free-form `botInstructions` with product-looking numbers;
- conflicting legacy product prices;
- ambiguous contact numbers;
- repeat migration/idempotency;
- rollback to the byte-equivalent legacy config.

Assert ambiguous facts are archived and listed in `reviewItems`, never activated.
Assert `botInstructions` does not populate catalog, rules, or routing.

### Step 2.5 — Implement pure migrator and GREEN

The pure migrator accepts a config value and returns:

```js
{
  migratedConfig,
  report: { status, mapped, reviewItems, legacyHash },
  rollbackConfig
}
```

Do not persist yet.

Run:

```powershell
node --test tests/policy/merchant-policy-migrator.test.js
```

### Step 2.6 — Mutation kill

Mutate the migrator in-memory so it parses a price or contact from
`botInstructions`. The ambiguous-legacy test must fail.

Record RED-mutant/GREEN-restored evidence.

---

## Task 3: Reversible Local Persistence and Migration Review

**Create:**

- `src/db/migrations/20260726-reply-audit.js`
- `src/services/audit/reply-audit-store.js`
- `scripts/migrate-merchant-policy.js`
- `tests/db/reply-audit-migration.test.js`
- `tests/db/merchant-policy-migration-script.test.js`
- `tests/audit/reply-audit-chain.test.js`

**Modify after RED only:**

- `src/db/migrations/init.js`

### Step 3.1 — RED reversible migration tests

The audit migration creates:

```sql
reply_audit_events(
  id uuid primary key,
  correlation_id uuid not null,
  sequence_no integer not null,
  user_id uuid not null,
  conversation_id uuid,
  customer_id text,
  destination text not null,
  send_class text not null,
  stage text not null,
  policy_version text not null,
  content text,
  content_hash text not null,
  evidence_refs jsonb not null,
  violations jsonb not null,
  metadata jsonb not null,
  created_at timestamptz not null,
  unique(correlation_id, sequence_no)
)
```

and a durable send reservation table:

```sql
whatsapp_send_reservations(
  user_id uuid not null,
  idempotency_key text not null,
  correlation_id uuid not null,
  destination text not null,
  policy_version text not null,
  status text not null,
  provider_message_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key(user_id, idempotency_key)
)
```

Tests assert:

- `up` is idempotent;
- `down` exports rows to a supplied preservation sink before removal;
- `down` refuses to proceed when preservation fails;
- `up → insert → down → up → restore` preserves audit content;
- cross-tenant reservation collision is impossible;
- same-tenant duplicate key is rejected/returned deterministically.

Run:

```powershell
node --test tests/db/reply-audit-migration.test.js
```

Expected RED: migration module absent.

### Step 3.2 — Implement migration and audit store

The sprint runs migration tests against a fake SQL contract or explicitly local
database only. It does not invoke `npm run db:migrate` against any configured
external database.

Append operations require the next sequence number transactionally. No update or
delete API is exposed by `reply-audit-store`.

### Step 3.3 — RED/GREEN policy migration script

The script defaults to `--dry-run`; persistence requires explicit `--apply` and
an injected/local database. It writes `merchantPolicy` in the existing
`bot_configs.config`, preserving legacy fields. It outputs review IDs without
guessing.

Run:

```powershell
node --test tests/db/merchant-policy-migration-script.test.js tests/audit/reply-audit-chain.test.js
```

### Step 3.4 — Rollback mutation

Mutate preservation failure handling to continue. The rollback test must fail.

---

## Task 4: Deterministic Product-Bound Validator and Safe Fallback

**Create:**

- `src/services/ai/deterministic-reply-validator.js`
- `src/services/ai/deterministic-fallback.js`
- `tests/ai/product-bound-grounding.test.js`
- `tests/ai/deterministic-reply-validator.test.js`
- `tests/ai/deterministic-fallback.test.js`
- `tests/ai/current-turn-relevance.test.js`

### Step 4.1 — RED fact-linking tests

Required cases:

- Product A price does not authorize Product B.
- A variant duration does not authorize another variant.
- Samsung compatibility does not authorize iPhone.
- ordinary delivery does not authorize free delivery.
- one warranty does not authorize a different product warranty.
- a number in persona or archived legacy text authorizes nothing.
- exact canonical product fact passes with evidence reference.
- a general greeting contains no commercial claim and passes.
- the reported phone number/advice reply is rejected as off-topic and
  unauthorized contact.

Run:

```powershell
node --test tests/ai/product-bound-grounding.test.js tests/ai/deterministic-reply-validator.test.js tests/ai/current-turn-relevance.test.js
```

Expected RED: validator absent.

### Step 4.2 — Implement claim extraction and validation

Normalize Arabic/Latin digits, currencies, punctuation, URLs, phone numbers, and
product aliases. Claim extraction may be conservative: uncertain material claims
are violations, not inferred approvals.

The validator accepts only:

```js
validateAutomatedReply({
  customerText,
  conversationFocus,
  reply,
  compiledPolicy,
  platformPolicy
})
```

It does not accept raw config or LLM verdicts.

### Step 4.3 — RED fallback tests

With empty/missing evidence, generated fallback must contain none of:

- digits;
- phone/URL patterns;
- price/currency;
- time/duration;
- promise/availability/refund/warranty/discount phrases.

When passed an authorized contact/product evidence reference, it may render only
the exact referenced value and is revalidated.

### Step 4.4 — Implement finite templates and GREEN

```powershell
node --test tests/ai/product-bound-grounding.test.js tests/ai/deterministic-reply-validator.test.js tests/ai/deterministic-fallback.test.js tests/ai/current-turn-relevance.test.js
```

### Step 4.5 — Mutation kill

Mutants:

- replace product-linked evidence lookup with global numeric lookup;
- skip contact validation;
- skip current-turn relevance;
- allow fallback digits.

Every mutant must cause a focused test failure.

---

## Task 5: Unified Fail-Closed Send Gateway

**Create:**

- `src/services/whatsapp/whatsapp-send-gateway.js`
- `src/services/whatsapp/whatsapp-transport-adapter.js`
- `tests/whatsapp/send-gateway.test.js`
- `tests/whatsapp/send-gateway-fail-closed.test.js`
- `tests/whatsapp/send-class-contracts.test.js`
- `tests/whatsapp/send-gateway-idempotency.test.js`

### Step 5.1 — RED gateway contract tests

Assert all requests fail before transport when missing:

- send class;
- user/tenant;
- destination;
- idempotency key;
- `policyVersion`;
- merchant policy for merchant-scoped classes.

Assert automated sends load latest DB policy and ignore caller-provided compiled
policy/cache.

Assert human, campaign, platform alert, and handoff classes preserve their
defined content behavior while sharing scope, audit, version, and idempotency.

### Step 5.2 — RED dependency-failure matrix

Inject failure at:

- tenant scope query;
- policy query;
- policy validation/compiler;
- reservation;
- original audit append;
- deterministic validation;
- repair revalidation;
- final audit append.

For each failure: transport calls = 0, state is retryable/held, and no allow event
is recorded.

### Step 5.3 — Implement gateway and low-level adapter

The adapter has one method:

```js
transport.send({ destination, content, media, correlationId })
```

It contains the only `client.sendMessage` call and returns normalized provider
metadata. The gateway never accepts a raw WhatsApp client from a producer.

### Step 5.4 — GREEN and mutation kill

```powershell
node --test tests/whatsapp/send-gateway.test.js tests/whatsapp/send-gateway-fail-closed.test.js tests/whatsapp/send-class-contracts.test.js tests/whatsapp/send-gateway-idempotency.test.js
```

Mutate each fail-closed return to continue; the corresponding test must fail
because transport is called.

---

## Task 6: Cut Automated Reply Pipeline Over to Canonical Policy

**Modify after RED only:**

- `lib/ai-client.js`
- `src/workers/ai-worker.js`
- `src/workers/outgoing-whatsapp-worker.js`
- `src/services/ai/knowledge-retrieval.js`
- `src/services/products/product-knowledge.js`
- `src/services/ai/reply-quality-gate.js`
- `src/services/ai/pre-send-review.js`
- `src/workers/escalation-routing.js`

**Create/modify tests:**

- `tests/policy/no-runtime-bot-instructions.test.js`
- `tests/ai/llm-cannot-authorize.test.js`
- `tests/whatsapp/policy-change-before-send.test.js`
- `tests/whatsapp/automated-pipeline-gateway.test.js`
- existing focused AI/outgoing tests

### Step 6.1 — RED no-legacy-runtime test

Scan runtime modules and execute fixtures proving that a config containing only
legacy `botInstructions` becomes `needs_review` and does not draft/send.

### Step 6.2 — RED stale-price test

Queue a reply using policy version V1/price A. Before gateway execution, fake DB
returns V2/price B. Assert:

- V1 cannot be sent;
- old price is rejected;
- a safe policy-grounded repair may use only V2;
- audit records requested and active versions.

### Step 6.3 — RED LLM-authority test

Make LLM reviewer return `pass`, high confidence, invented number/contact, or an
escalation marker. Deterministic validator must still block it. Make LLM reviewer
return `fail` on an otherwise valid deterministic reply; it may advise but cannot
create routing or authorize an alternate fact.

### Step 6.4 — Implement cutover

- AI prompt receives compiled persona and selected evidence, never raw config.
- Product knowledge accepts compiled policy only.
- learned replies are tagged non-authoritative and cannot populate evidence.
- quality reviewers return advisory metadata only.
- escalation routing accepts stable routing rule/contact IDs only.
- outgoing worker constructs gateway request unconditionally.
- remove optional pre-send authorization flag.

### Step 6.5 — GREEN focused suites

```powershell
node --test tests/policy/no-runtime-bot-instructions.test.js tests/ai/llm-cannot-authorize.test.js tests/whatsapp/policy-change-before-send.test.js tests/whatsapp/automated-pipeline-gateway.test.js tests/reply-quality-gate.test.js tests/pre-send-review.test.js
```

### Step 6.6 — Run architectural tests

`single-policy-source` should now be GREEN for automated runtime. The send-site
tests may remain RED until Task 8, and that intermediate status is recorded.

---

## Task 7: Canonical Configuration Writers

**Modify after RED only:**

- `src/services/prompt-edit/prompt-edit.service.js`
- product import service and routes
- dashboard configuration serialization in `dashboard/index.html`
- config controller read/write paths
- relevant tests

**Create:**

- `tests/policy/dashboard-policy-roundtrip.test.js`
- `tests/policy/prompt-edit-policy-write.test.js`
- `tests/policy/product-import-policy-write.test.js`
- `tests/policy/no-policy-version-forgery.test.js`

### Step 7.1 — RED writer tests

Assert every writer:

- validates canonical policy;
- derives, not accepts, `policyVersion`;
- writes only `merchantPolicy` for runtime facts;
- archives legacy input;
- marks uncertain edits `needs_review`;
- never silently populates facts from prose.

### Step 7.2 — Implement and GREEN

Prompt editing proposes typed operations against stable IDs. The LLM may propose
an operation but deterministic validation decides whether it is valid and
whether review is required.

```powershell
node --test tests/policy/dashboard-policy-roundtrip.test.js tests/policy/prompt-edit-policy-write.test.js tests/policy/product-import-policy-write.test.js tests/policy/no-policy-version-forgery.test.js
```

---

## Task 8: Move Every Other WhatsApp Sender Through the Gateway

**Modify after RED only:**

- `src/workers/campaign-worker.js`
- `src/controllers/bot.controller.js`
- `src/services/monitoring/alerts.js`
- `src/services/monitoring/unlink-alert.js`
- escalation bridge
- quota-stop producer
- owner/group notifications in `src/workers/outgoing-whatsapp-worker.js`
- Baileys manager only as required to expose the transport adapter

**Create:**

- `tests/whatsapp/manual-send-gateway.test.js`
- `tests/whatsapp/campaign-send-gateway.test.js`
- `tests/whatsapp/alert-send-gateway.test.js`
- `tests/whatsapp/handoff-send-gateway.test.js`

### Step 8.1 — RED send-class tests

Assert:

- `human_manual_reply` text remains byte-equivalent through the gateway;
- `campaign` text/media remain byte-equivalent;
- `platform_alert` uses platform policy version and an authorized internal
  destination;
- `handoff_notification` resolves its contact from canonical routing;
- all classes are audited and idempotent;
- wrong-tenant destinations fail closed.

### Step 8.2 — Implement adapters and GREEN

Remove all direct sends. Keep the low-level network call only in
`whatsapp-transport-adapter.js`.

### Step 8.3 — Architecture GREEN

```powershell
node --test tests/architecture/single-whatsapp-transport.test.js tests/architecture/mandatory-send-gateway.test.js tests/whatsapp/manual-send-gateway.test.js tests/whatsapp/campaign-send-gateway.test.js tests/whatsapp/alert-send-gateway.test.js tests/whatsapp/handoff-send-gateway.test.js
```

Expected: zero direct-send and policy-version violations.

---

## Task 9: Selectively Restore Useful `70f9fd1` Protections

**Restore or create behavioral cases in:**

- `tests/post-process-reply.test.js`
- `tests/reply-quality-gate.test.js`
- `tests/reply-validator.test.js`
- `tests/product-knowledge.test.js`
- `tests/pre-send-human-handoff.test.js`
- `tests/ai-price-objection-empathy.test.js`
- `tests/regressions/revert-70f9fd1.test.js`

### Step 9.1 — Extract tests, not old authority

Use `git show 70f9fd1^:<path>` to inspect deleted tests. Port only cases
consistent with the official spec. Do not restore:

- LLM confidence as routing authority;
- broad keyword handoff heuristics;
- prompt-prose product parsing;
- marker invention by reviewers;
- stale cached policy authorization.

### Step 9.2 — RED restored regressions

Group failures by guard:

- avoided content and marker secrecy;
- product-bound material claims;
- current-turn relevance;
- safe product matching;
- explicit human request and selected contact;
- false handoff prevention;
- missing material fact behavior.

### Step 9.3 — Implement minimal guard fixes and GREEN

Prefer the new deterministic validator and policy compiler. Avoid duplicating
business rules in old validators or prompts.

### Step 9.4 — Mutation kill

Each restored guard receives a named mutant in the critical mutation manifest.

---

## Task 10: Concurrency, Retry, Duplicate, Isolation, and Failure Testing

**Create:**

- `tests/stabilization/concurrent-same-conversation.test.js`
- `tests/stabilization/concurrent-multi-tenant.test.js`
- `tests/stabilization/duplicate-webhook-and-job.test.js`
- `tests/stabilization/retry-idempotency.test.js`
- `tests/stabilization/service-failure-matrix.test.js`
- `tests/stabilization/policy-change-race.test.js`
- `tests/helpers/deterministic-runtime-harness.js`

### Step 10.1 — RED concurrency tests

Use barriers, not sleeps. Launch at least:

- 20 customers across 4 tenants with unique secrets;
- duplicate inbound provider IDs;
- duplicate outgoing idempotency keys;
- simultaneous same-conversation sends;
- policy update racing a queued send.

Assertions:

- no cross-scope context/evidence;
- exactly one transport call per idempotency key;
- monotonic audit sequence;
- latest policy version at network boundary;
- old commercial facts blocked.

### Step 10.2 — RED failure matrix

Table-drive every injectable dependency failure. Assert zero transport calls
before all mandatory stages succeed.

### Step 10.3 — Implement transaction/reservation corrections and GREEN

Changes are limited to gateway/audit/reservation/ingest code and require focused
tests first.

---

## Task 11: Deterministic Critical Simulation and Mutation Runner

**Create:**

- `scripts/simulate-stabilization.js`
- `scripts/run-critical-mutations.js`
- `tests/simulation/stabilization-simulation.test.js`
- `tests/mutation/critical-guards.test.js`
- `tests/fixtures/simulation-critical-matrix.json`
- `docs/stabilization/simulation-report.json`
- `docs/stabilization/mutation-report.json`

**Modify:**

- `package.json` scripts only after RED tests require the commands

### Step 11.1 — Define critical matrix before generator

Every required case from spec section 15 has:

- stable case ID;
- minimum occurrence count;
- generator dimensions;
- deterministic assertions;
- expected decision;
- required evidence/audit fields.

### Step 11.2 — RED harness test

Fail if:

- fewer than 10,000 sequences execute;
- any critical case has zero coverage;
- any invariant lacks an assertion;
- seed/report is missing;
- simulation uses a network dependency.

### Step 11.3 — Implement seeded simulation

Default seed: `20260726`. Generate at least 10,000 event sequences and write a
machine-readable report. A passing count without complete critical coverage is a
failure.

### Step 11.4 — Implement source mutation runner

Load mutated CommonJS modules from source strings in a temporary module context.
Each named mutant disables exactly one guard:

- policy required;
- policy version required;
- tenant scope;
- destination scope;
- audit before network;
- idempotency reservation;
- product-bound numeric lookup;
- contact authorization;
- current-turn relevance;
- forbidden-content non-restoration;
- fail-closed dependency handling.

The runner executes the owning focused test against each mutant. Success means
the test process fails for the expected assertion. A surviving mutant fails the
mutation suite and triggers the sprint stop criterion.

### Step 11.5 — Run

```powershell
node --test tests/simulation/stabilization-simulation.test.js
node --test tests/mutation/critical-guards.test.js
node scripts/simulate-stabilization.js --seed 20260726 --sequences 10000 --report docs/stabilization/simulation-report.json
node scripts/run-critical-mutations.js --report docs/stabilization/mutation-report.json
```

---

## Task 12: Full Verification and Readiness Report

**Create:**

- `docs/stabilization/readiness-report-2026-07-26.md`
- `docs/stabilization/final-tests.tap`
- `docs/stabilization/source-of-truth-before-after.md`
- `docs/stabilization/restored-protections.md`

### Step 12.1 — Static invariant verification

```powershell
rg -n --glob '!tests/**' --glob '!docs/**' --glob '!legacy/**' "botInstructions" lib src dashboard scripts
rg -n --glob '!tests/**' --glob '!docs/**' "client\\.sendMessage|sock\\.sendMessage" lib src
rg -n "preSendReviewRequired" lib src
```

Expected:

- no runtime `botInstructions`;
- only transport adapter direct send;
- no optional final-gate flag.

### Step 12.2 — Targeted critical suites

Run policy, architecture, gateway, failure, concurrency, regression, simulation,
and mutation suites independently and record exact results.

### Step 12.3 — Full suite

```powershell
node --test --test-reporter=tap --test-reporter-destination=docs/stabilization/final-tests.tap
```

### Step 12.4 — Dependency and repository checks

```powershell
npm audit --json
git diff --check
git status --short
```

No automatic `npm audit fix`, dependency major upgrade, deploy, push, or
production connection is authorized.

### Step 12.5 — Readiness verdict

Report:

- every discovered root cause;
- source-of-truth before/after;
- restored protections;
- tests that were RED then GREEN;
- mutation score and any survivor;
- simulation seed, count, and critical coverage;
- migration up/down evidence;
- remaining bugs/risks;
- explicit **READY** or **NOT READY**.

If any known bug, survivor, direct send, legacy runtime read, missing
policyVersion, fail-open path, rollback failure, or high-severity unaccepted
dependency risk remains, verdict is **NOT READY**.

No Shadow Mode or deployment work begins in this plan.

## Expected File and Migration Surface Before Production-Code Changes

### New runtime modules

- policy schema, compiler, platform policy, and legacy migrator;
- deterministic reply validator and fallback;
- unified send gateway and sole transport adapter;
- append-only audit store.

### New tooling and tests

- architecture guards;
- policy/migration tests;
- gateway/send-class/failure tests;
- restored regressions;
- concurrency/retry/isolation harness;
- deterministic simulation and critical mutation runner;
- readiness evidence.

### Modified runtime integration

- AI client/worker and outgoing worker;
- product knowledge, policy retrieval, old quality/pre-send layers;
- escalation routing;
- config writers, prompt edit, product import, and dashboard;
- manual, campaign, alert, unlink, quota, and handoff senders;
- migration registry.

### Migration

- one reversible local audit/reservation migration with tested `up` and
  preserving `down`;
- merchant policy data migration within existing `bot_configs.config`, with dry
  run, idempotency, byte-preserving legacy archive, review queue, and rollback;
- no production migration execution.

### Principal implementation risks

- ambiguous legacy facts must reduce automation rather than be guessed;
- sender cutover can reveal hidden coupling in campaigns/alerts;
- fresh-policy validation can hold stale queued replies;
- transport timeout ambiguity requires durable reservation;
- Arabic claim extraction must be conservative without corrupting human text;
- existing implementation-detail tests may need replacement by behavior tests;
- current dependency audit has 10 high-severity findings.
