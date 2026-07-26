# Production Stabilization Sprint — Official Design Specification

Status: **Approved for local implementation**

Date: 2026-07-26

Baseline: `70f9fd1eb6770139592bf7b12a811937fcc4deee`

Branch: `codex/stabilization-sprint`

This document is the official implementation reference for the sprint. If code,
tests, older plans, prompts, or comments conflict with this specification, this
specification wins. A new architectural decision that changes its scope or can
cause data loss requires explicit user review before implementation.

## 1. Objective and Non-Goals

The objective is to make customer-facing WhatsApp reply delivery deterministic,
auditable, tenant-isolated, idempotent, and grounded in a single merchant
policy. The sprint fixes root causes and adds regression evidence; it does not
patch only the reported sentence.

The sprint is local only. It does not:

- deploy to Railway or any other environment;
- connect to, read from, or write to production;
- enable Shadow Mode;
- add unrelated product features;
- claim readiness because the existing 1,438 tests pass;
- reverse commit `70f9fd1` wholesale.

Shadow Mode and production deployment are separate phases requiring explicit
approval after the readiness report.

## 2. Reported Incident

The reported reply greeted the customer, then instructed them to re-enter an
unspecified number and contact customer service at `0593216744`. The visible
conversation did not establish that this advice, phone number, or problem type
was relevant or authorized.

The safety failure is not merely undesirable wording. The pipeline allowed an
automated reply to:

1. answer a topic not established by the current customer turn;
2. introduce a commercial/service contact fact without traceable policy
   evidence;
3. survive multiple probabilistic review and post-processing stages;
4. reach a send path whose final review was optional rather than structural.

## 3. Current Message Path

The current automated WhatsApp path is:

```text
Baileys inbound event
  -> stale/sync/generation filters
  -> MessageIngestService persists inbound message
  -> do-not-reply and auto-reply configuration checks
  -> BullMQ AI job
  -> AI worker loads config and learned replies
  -> instant reply or LLM draft
  -> avoided-content stripping
  -> reply validator
  -> LLM quality reviewer
  -> post-processing, style, grounding, escalation, combine, dedup
  -> outbound message persisted
  -> BullMQ outgoing job
  -> persisted message reloaded
  -> optional pre-send review selected by payload flag
  -> LLM pre-send review and post-processing
  -> escalation routing
  -> WhatsApp client send
```

Every current layer that can create, modify, restore, suppress, reroute, or
authorize text is part of the stabilization boundary:

- `lib/ai-client.js`
- `src/workers/ai-worker.js`
- `src/services/ai/knowledge-retrieval.js`
- `src/services/products/product-knowledge.js`
- `lib/post-process-reply.js`
- `src/services/ai/reply-validator.js`
- `src/services/ai/reply-quality-gate.js`
- `src/services/ai/pre-send-review.js`
- `src/workers/escalation-routing.js`
- `src/workers/outgoing-whatsapp-worker.js`
- the Baileys client adapter

Other current WhatsApp senders are also inside the send-boundary scope:

- dashboard/manual send in `src/controllers/bot.controller.js`;
- campaigns in `src/workers/campaign-worker.js`;
- platform alerts in `src/services/monitoring/alerts.js`;
- unlink alerts in `src/services/monitoring/unlink-alert.js`;
- escalation bridge and quota-stop messages;
- owner/group notifications inside the outgoing worker.

## 4. Root Causes Established Before Implementation

The following are evidence-backed root causes, not final readiness conclusions:

### RC-01 — Multiple Runtime Sources of Merchant Truth

Product and price evidence is assembled from both structured `config.products`
and parsed free-form `config.botInstructions`.

Merchant reply facts also enter through `autoReplyKeywords`, learned replies,
store metadata, and hard-coded prompt blocks. The same business fact can
therefore exist in conflicting forms.

### RC-02 — `botInstructions` Is Executable Data

`botInstructions` currently controls persona, facts, products, prices,
escalation contacts, and prompt edits. It has no type-safe boundary between
style and commercial truth. Runtime parsing guesses structure from legacy prose.

### RC-03 — Final Authorization Is Optional

The outgoing worker invokes pre-send review only when producers set
`preSendReviewRequired: true`. Some sources omit the flag. A producer can
therefore bypass the intended final gate without violating an interface.

### RC-04 — Multiple Physical Send Sites

`bot.client.sendMessage` exists in the outgoing worker, campaign worker,
controller, monitoring alerts, and unlink alerts. This prevents one enforced
audit, tenant, destination, policy-version, and idempotency contract.

### RC-05 — Probabilistic Components Hold Safety Authority

LLM quality reviewers participate in pass/repair/escalation decisions. Their
confidence and classification have previously caused false handoffs, while
their semantic flexibility still does not prove product-linked grounding.

### RC-06 — Numeric Grounding Is Not Product-Bound

A number appearing anywhere in broad merchant evidence can authorize a claim
about a different product. A price must be linked to the product/variant being
discussed, not merely found somewhere in concatenated text.

### RC-07 — Unsafe Fail-Open Behavior

At least one configuration-load failure defaults to automatic replies being
enabled. Policy and validation outages can therefore degrade into sending
instead of holding.

### RC-08 — Stale Policy at Delivery Time

Final review can resolve merged in-memory configuration instead of loading the
latest committed merchant policy from the database. A price changed while a job
waits can leave a previously generated reply authorized against stale data.

### RC-09 — Transformations Are Not Fully Auditable

The database stores the resulting message and compact review metadata, but not a
complete append-only sequence containing the original draft, each mutation,
evidence set, deterministic violations, final decision, network attempt, and
result.

### RC-10 — Cleaning Can Restore Forbidden Content

If avoided-content cleaning leaves a very short string, the existing code may
return the original text. A protection can therefore reintroduce exactly what
it removed.

### RC-11 — Regression Coverage Was Removed

Commit `70f9fd1` deleted or weakened tests for material claims, current-turn
relevance, forbidden content, product matching, phone privacy, and handoff
behavior. The green count does not exercise all previously protected behavior.

### RC-12 — Many Tests Prove Wiring, Not Behavior

Several tests inspect source text or flag placement. Such tests can remain green
when the protection is disabled through another route. Every claimed guard needs
a behavioral kill test or mutation that proves the test fails when the guard is
removed.

### RC-13 — Simulation Is Too Narrow

The existing replay tooling covers a small sample and may depend on external
state. It does not deterministically exercise 10,000 seeded critical sequences,
concurrency, duplicate webhooks, retries, tenant crossing, policy changes, and
service failures.

## 5. Source of Truth — Before and After

| Domain | Before | After |
| --- | --- | --- |
| Products and prices | `config.products`, parsed `botInstructions`, instant replies, learned replies, prompt text | `merchantPolicy.catalog.products` only |
| Persona | `botInstructions`, `replyStyle`, `responseLanguage`, hard-coded prompt wording | `merchantPolicy.persona`, constrained by `platformReplyPolicy` |
| Merchant reply rules | `botInstructions`, `autoReplyKeywords`, prompt-edit sections, hard-coded prompt text | `merchantPolicy.businessRules` and `merchantPolicy.instantReplies` |
| Prohibitions | `avoidWords`, `avoidPhrases`, do-not-reply lists, prompt rules, post-processing heuristics | `merchantPolicy.prohibitions` plus versioned `platformReplyPolicy` |
| Routing and contacts | escalation fields plus numbers parsed from `botInstructions` plus LLM markers | `merchantPolicy.routing`; LLM output has no routing authority |
| Fact verification | concatenated config text, products, keywords, learned replies, LLM judgment | deterministic evidence index compiled only from canonical policy |
| Learned replies | potentially injected as answer evidence | non-authoritative draft suggestions, never fact evidence |
| Final send authority | producer flags plus outgoing worker branches plus direct sends | one `WhatsAppSendGateway` and one low-level transport adapter |

There may be two *classes* of policy after the migration, but not two competing
merchant truth sources:

1. `platformReplyPolicy`: versioned code-owned invariants, such as internal
   marker secrecy, tenant isolation, and mandatory send classes.
2. `merchantPolicy`: versioned merchant-owned facts and preferences.

Platform policy cannot invent merchant facts. Merchant policy cannot weaken
platform isolation, audit, idempotency, or fail-closed rules.

## 6. Canonical Merchant Policy

The canonical policy remains stored in `bot_configs.config` to avoid a parallel
configuration store. Its required runtime shape is:

```js
{
  merchantPolicy: {
    schemaVersion: 1,
    policyVersion: "sha256:<canonical-json-hash>",
    status: "active" | "needs_review" | "invalid",
    catalog: {
      products: [
        {
          id: "stable-merchant-product-id",
          name: "string",
          aliases: ["string"],
          description: "string",
          variants: [
            {
              id: "stable-variant-id",
              name: "string",
              price: { amountMinor: 12000, currency: "SAR" },
              duration: "string|null",
              availability: "string|null",
              attributes: {}
            }
          ],
          links: [],
          attributes: {}
        }
      ]
    },
    persona: {
      role: "customer_service_agent",
      displayName: "string|null",
      language: "ar",
      dialect: "saudi|neutral",
      tone: "string",
      brevity: "concise|normal",
      formatting: {}
    },
    businessRules: [
      { id: "stable-rule-id", topic: "string", statement: "string" }
    ],
    prohibitions: {
      words: [],
      phrases: [],
      claims: [],
      destinations: []
    },
    routing: {
      contacts: [],
      rules: [],
      pauseAfterHandoff: false
    },
    instantReplies: [
      {
        id: "stable-reply-id",
        triggers: [],
        reply: "string",
        evidenceRefs: ["product/rule/contact IDs"]
      }
    ],
    migration: {
      legacyArchived: {},
      reviewItems: []
    }
  }
}
```

`policyVersion` is derived from canonical JSON excluding the version itself and
volatile migration timestamps. Runtime callers cannot supply or override it.

## 7. Legacy Migration Contract

The migration is explicit, deterministic, idempotent, dry-runnable, and
reversible.

- Structured existing fields are mapped only when their meaning is unambiguous.
- `config.products` maps to `merchantPolicy.catalog.products`.
- `replyStyle` and `responseLanguage` map to typed persona fields.
- `avoidWords` and `avoidPhrases` map to prohibitions.
- explicit escalation fields map to routing.
- `autoReplyKeywords` maps to instant replies, with evidence references only
  when deterministically resolvable.
- `botInstructions` is archived verbatim under
  `merchantPolicy.migration.legacyArchived.botInstructions`.
- No runtime module may read `botInstructions` after cutover.
- No silent fallback to `botInstructions` is allowed.
- Free-form legacy statements that cannot be typed with high confidence become
  `reviewItems`; they are not interpreted, guessed, or activated.
- Any unresolved material commercial fact sets policy status to `needs_review`.
- `needs_review`, missing policy, invalid policy, or compiler failure blocks
  automated customer replies.
- The original legacy config is retained in the same JSON document for rollback
  but is runtime-inert.
- Rollback switches the runtime policy reader version; it does not destroy the
  migrated policy or legacy archive.

The database migration for append-only audit structures must expose tested
`up` and `down` operations. `down` must preserve exported audit data before
removing any new table. No destructive production migration is run in this
sprint.

## 8. Send Classes

Every WhatsApp outbound is assigned exactly one immutable class:

### `automated_customer_reply`

Full deterministic policy enforcement:

- current-turn relevance;
- customer role/persona;
- product-linked factual grounding;
- prices, numbers, URLs, durations, features, promises, availability,
  compatibility, warranty, refunds, discounts, and delivery;
- prohibitions;
- routing authorization;
- internal marker secrecy;
- policy status/version;
- tenant/conversation/customer scope;
- idempotency.

### `human_manual_reply`

The employee's words are preserved unless an explicit merchant/platform policy
authorizes alteration. The gateway still enforces:

- authenticated tenant scope;
- destination/conversation ownership;
- internal-secret leakage rules;
- immutable audit;
- idempotency.

It does not apply automated current-turn, style, or product wording repairs.

### `campaign`

Campaign wording is not treated as a conversational reply and is not altered by
reply relevance logic. It still receives:

- tenant and campaign-recipient scope;
- destination authorization;
- immutable audit;
- media/text integrity;
- idempotency.

### `platform_alert`

Alerts and unlink notices use an explicitly authorized internal destination
class. They pass the same adapter for audit and idempotency but are not evaluated
as customer replies.

### `handoff_notification`

Employee/group handoff notifications are internal messages with explicit
merchant routing references. The selected contact must exist in the active
policy version.

## 9. Unified Send Gateway

Only the low-level WhatsApp transport adapter may call the underlying
`client.sendMessage`. Every other caller invokes `WhatsAppSendGateway.send`.

Required request fields:

```js
{
  sendClass,
  userId,
  channelId: "whatsapp",
  destination,
  conversationId,
  customerId,
  messageId,
  idempotencyKey,
  content,
  contentOrigin,
  policyVersion
}
```

`policyVersion` is mandatory for every send class. For platform alerts it is the
active `platformReplyPolicy.version`; for merchant-scoped messages it also binds
the latest merchant policy version.

Gateway order:

1. Validate the typed request and send class.
2. Validate tenant/channel/destination/conversation ownership.
3. Load the latest policy from the database, never from a stale runtime cache.
4. Validate policy schema, status, and requested policy version.
5. Reserve the idempotency key durably.
6. Append the original content audit event before any mutation.
7. For automated replies, compile deterministic evidence from canonical policy.
8. Apply deterministic normalization that never restores removed content.
9. Run deterministic validation.
10. Decide `allow`, `repair`, `block`, or `hold_for_review`.
11. If repaired, validate the repaired output again from the beginning.
12. Append the final decision and final content before network I/O.
13. Invoke the single low-level transport adapter.
14. Append the provider result or error.

No LLM is called inside final authorization. LLM output and reviewers are
untrusted draft/advisory inputs. They can never turn a deterministic rejection
into an allow.

## 10. Fail-Closed Rules

An automated customer reply is not sent when any of these fail:

- database access needed for scope, policy, audit, or idempotency;
- merchant policy load;
- policy schema validation;
- policy status is not `active`;
- policy version binding;
- deterministic evidence compilation;
- deterministic validation;
- durable idempotency reservation;
- pre-network audit persistence.

The job may retry safely. If retries are exhausted, it is held for review and
recorded; it does not send a best-effort answer.

## 11. Deterministic Fallback

The fallback is generated from a finite, versioned template set. It cannot
contain a price, phone number, URL, discount, duration, delivery promise,
availability promise, warranty, refund statement, compatibility claim, or
commercial commitment unless the exact rendered value is referenced from the
active policy.

The ungrounded default may only:

- ask one concise clarification tied to the current turn; or
- state that the information is unavailable and hold for human review without
  naming a contact.

If an authorized routing contact is rendered, it is resolved by stable contact
ID from `merchantPolicy.routing`, never parsed from prose or generated by an
LLM.

## 12. Deterministic Validation

Validation produces structured violations with evidence references. At minimum:

- `ROLE_NOT_CUSTOMER_SERVICE`
- `OFF_TOPIC_CURRENT_TURN`
- `UNSUPPORTED_PRODUCT`
- `UNSUPPORTED_PRODUCT_PRICE`
- `UNSUPPORTED_NUMBER`
- `UNSUPPORTED_URL`
- `UNSUPPORTED_DURATION`
- `UNSUPPORTED_AVAILABILITY`
- `UNSUPPORTED_DISCOUNT`
- `UNSUPPORTED_DELIVERY`
- `UNSUPPORTED_WARRANTY`
- `UNSUPPORTED_REFUND`
- `UNSUPPORTED_COMPATIBILITY`
- `UNSUPPORTED_COMMERCIAL_PROMISE`
- `PROHIBITED_CONTENT`
- `UNAUTHORIZED_CONTACT`
- `INTERNAL_MARKER_LEAK`
- `POLICY_MISSING`
- `POLICY_INVALID`
- `POLICY_VERSION_MISMATCH`
- `TENANT_SCOPE_MISMATCH`
- `DESTINATION_SCOPE_MISMATCH`
- `DUPLICATE_SEND`

Product fact authorization requires a resolved product/variant identity and an
exact evidence reference. Broad merchant text or a matching number belonging to
another product is insufficient.

## 13. Audit Model

Audit is append-only and reconstructs the complete reply lifecycle:

- correlation ID and idempotency key;
- send class and content origin;
- tenant, conversation, customer, and destination identifiers;
- original LLM/manual/campaign/alert draft;
- every transformation stage with before/after hashes and, where permitted,
  content;
- policy schema version and `policyVersion`;
- retrieved product/rule/contact evidence references;
- LLM advisory output, explicitly marked non-authoritative;
- deterministic violations;
- final decision and reason;
- fallback template and evidence references, if used;
- network attempt number;
- provider message ID or error.

The final decision and final content must be persisted before the network call.
Audit failure is fail-closed for automated replies.

## 14. Selective Recovery From `70f9fd1`

Useful behavior is recovered as new or adapted behavioral tests, not by blindly
reverting code. Candidate protections:

- exact avoided words and punctuation-normalized avoided phrases;
- no restoration of forbidden content after cleaning;
- AI identity and internal marker removal;
- contact privacy;
- material nonnumeric claims: compatibility, add-ons, free delivery,
  availability, warranty, refunds, and future promotions;
- current-turn relevance and stale-topic/old-discount rejection;
- actual customer text isolation in batched input;
- product-bound warranty and price evidence;
- generic duration/subscription words not matching unrelated products;
- generic pricing questions still retrieving relevant catalog entries;
- valid human requests and configured contact selection;
- false handoff prevention for ordinary price objections and grounded answers;
- missing material facts taking the configured safe route.

Any recovered test must fail against the unsafe baseline or against a deliberate
mutation that disables its guard.

## 15. Test Strategy

### RED/GREEN Proof

For every root cause:

1. add a behavioral test that fails on baseline or a scoped unsafe fixture;
2. record the RED command, failure, and guard it proves;
3. implement the smallest architectural slice;
4. run the focused test GREEN;
5. run related regressions;
6. run a kill test/mutation that disables the guard and verify the test turns
   RED;
7. restore the guard and record final GREEN.

A test that stays green when its claimed protection is disabled is invalid and
triggers immediate stop.

### Required Critical Cases

- concurrent inbound messages for the same and different customers;
- BullMQ retries before and after reservation;
- duplicate WhatsApp webhooks/provider IDs;
- duplicate outgoing jobs/idempotency keys;
- tenant, store, conversation, customer, and destination mismatch;
- a price/policy change while a reply is queued;
- database failure at policy load, scope check, reservation, audit, and result
  persistence;
- validator/compiler failure;
- LLM timeout, malformed output, hallucinated price/contact, and conflicting
  reviewer advice;
- Redis/queue retries;
- transport timeout before and after a provider ID is returned;
- automated, human, campaign, alert, and handoff send classes;
- legacy policy with unambiguous mapping;
- ambiguous legacy policy marked `needs_review`;
- absent, invalid, stale, or wrong-tenant policy;
- forbidden content cleaning to empty/short output;
- product A price never authorizing product B;
- contact A never authorizing an invented contact;
- current-turn relevance after old unrelated conversation facts;
- multiple customer questions in one batch;
- owner reply race and escalation acknowledgement ordering.

### Seeded Simulation

At least 10,000 deterministic sequences are generated from a published seed and
critical-case matrix. Sequence count alone is not sufficient. Assertions include:

- zero cross-tenant or cross-customer content;
- zero duplicate network sends;
- zero send without an exact policy version;
- zero automated send after any required dependency failure;
- zero unsupported commercial claim;
- zero unauthorized contact;
- every attempted send has a complete pre-network audit chain;
- every allowed fact references canonical evidence;
- every injected mutation is detected by at least one test.

## 16. Immediate Stop Criteria

Implementation stops and reports immediately if any of these is observed:

- a second runtime source of merchant truth remains or is introduced;
- `client.sendMessage` exists outside the permitted low-level adapter;
- any send can occur without `policyVersion`;
- any automated send can occur after database or validation-gateway failure;
- a protection test remains green when that protection is disabled;
- a migration cannot be rolled back safely;
- a new architecture decision changes scope;
- an operation could cause data loss.

Finding one of these during baseline analysis is not itself a reason to abandon
the sprint: the current known violations are the work to be removed. The stop
criterion applies at the completion boundary of the architectural slice or when
the proposed implementation cannot remove the violation safely.

## 17. Readiness Gate

The system is not production-ready until all are true:

- known bugs in stabilization scope are zero;
- old and new regression suites are green;
- every new critical guard has RED and mutation-kill evidence;
- deterministic simulation is green for the full critical matrix;
- no runtime `botInstructions` reads;
- no direct send outside the adapter;
- no send without policy version;
- all fail-closed tests are green;
- migration dry-run, idempotency, rollback, and data-preservation tests are green;
- dependency vulnerabilities are resolved or explicitly accepted as a separate
  blocking risk;
- code and evidence have been reviewed locally.

The readiness report must clearly answer **ready** or **not ready** and list every
remaining issue. It must not recommend deployment merely because tests are
green.

## 18. Expected Implementation Surface

Expected new files:

- `src/policy/platform-reply-policy.js`
- `src/policy/merchant-policy-schema.js`
- `src/policy/merchant-policy-compiler.js`
- `src/policy/merchant-policy-migrator.js`
- `src/services/whatsapp/whatsapp-send-gateway.js`
- `src/services/whatsapp/whatsapp-transport-adapter.js`
- `src/services/ai/deterministic-reply-validator.js`
- `src/services/ai/deterministic-fallback.js`
- `src/services/audit/reply-audit-store.js`
- a reversible audit migration module
- targeted regression, architecture, failure-injection, concurrency, simulation,
  and mutation tests
- readiness evidence under `docs/stabilization/`

Expected modified files:

- `lib/ai-client.js`
- `lib/constants.js`
- `lib/post-process-reply.js`
- `src/workers/ai-worker.js`
- `src/workers/outgoing-whatsapp-worker.js`
- `src/workers/campaign-worker.js`
- `src/controllers/bot.controller.js`
- `src/services/monitoring/alerts.js`
- `src/services/monitoring/unlink-alert.js`
- `src/services/products/product-knowledge.js`
- `src/services/ai/knowledge-retrieval.js`
- `src/services/ai/reply-quality-gate.js`
- `src/services/ai/pre-send-review.js`
- `src/services/prompt-edit/prompt-edit.service.js`
- dashboard config serialization
- database migration registration

This list may shrink after TDD proves a smaller seam. Expanding it for a new
architectural capability requires review.

## 19. Principal Risks

- legacy prose may contain facts that cannot be migrated safely;
- moving all senders can expose undocumented alert or campaign assumptions;
- fail-closed behavior can reduce automated reply volume while increasing
  correctness;
- stale jobs created before policy migration need explicit holding behavior;
- transport timeouts create an ambiguous-send window requiring provider IDs and
  durable reservation;
- migration rollback must preserve newly written audit data;
- deterministic Arabic claim extraction can produce false positives unless
  product identity and normalized values are tested broadly;
- existing tests may encode obsolete implementation details;
- npm currently reports 10 high-severity dependency vulnerabilities.

These risks are surfaced, tested, and reported. They are not resolved by prompt
wording.
