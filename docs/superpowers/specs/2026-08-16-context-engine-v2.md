# Context Engine V2 — "Jawab understands the customer's ongoing story"

**Branch:** `claude/context-engine-v2` (base: `production`)
**Flag:** reuses `CONVERSATION_STATE_ENABLED` (unchanged; still OFF on production).
**Scope:** Platform-level, multi-tenant, generic. No hardcoded stores/products/
payment methods. Extends the existing V1 conversation-state engine — does NOT
build a second memory.

## What changed

1. **State shape V2** (`src/services/ai/conversation-state.js`) — strict superset
   of V1. New slots: `active_entities[]` (generic types + lifecycle metadata),
   `recent_topics[]`, `pending_expectation`, `salient_memories[]` (capped 50,
   value-scored), `last_turn_understanding{intent, resolved_references[],
   topic_transition, customer_correction}`, `schema_version`. V1 `active_entity`
   is DERIVED from the newest active entity so legacy readers keep working. Old DB
   rows upgrade in-memory with empty defaults (backward compatible).

2. **One extraction call does everything** (§18). The single auxiliary LLM call
   now also resolves references, detects corrections, maintains pending
   expectation, and updates salient memory. `max_tokens` 600→700. **No new
   per-turn LLM call.** Fail-soft preserved (timeout/non-JSON/error → prior state
   kept, never injected as current truth).

3. **CURRENT CUSTOMER CONTEXT block** (§14) — goal, topic, active entities,
   resolved references, open/resolved issues, pending expectation, facts,
   corrections, actions attempted, relevant memories + a behavioural footer.
   Deterministic **relevance selection** for memories (§13) and a **character
   budget** (§19) so context never balloons.

4. **Context → deterministic pricing bridge** (§15/§16). `deriveResolvedPricingContext`
   turns `active_entities` into a preferred product/variant/payment-method
   resolution that `resolvePriceComputation` consumes; config base price stays
   authoritative (§10). Fixes the live payment short-reply failure: a bare
   payment method then "كم؟" computes deterministically even when the raw turn
   names neither.

5. **Authority & safety.** Bot self-claims are quarantined as
   `previous_bot_statement` and rendered as UNVERIFIED — never a known_fact (§9).
   System/config/tool truth wins over memory (§10). Escalation is never triggered
   by mere ambiguity (§5).

6. **Diagnostic trace** (§27) — `buildStateTrace` emits shape/metadata only
   (type:ref entities, counts, intent, pending type, block size). No labels, fact
   values, phones, emails, purposes, keys, or conversation text.

## Verification

- **Acceptance suite** `tests/context-engine-v2-acceptance.test.js` — Tests A–N.
- **Unit suites** — shape, extraction, block, calc bridge, marker ordering, trace.
- **Long replay** `scripts/context-engine-v2-replay.js` — 30 turns through the
  real path (history→extraction→resolve→computePrice→system prompt). Caught a real
  bug (lexicographic `last_seen` ordering).
- **Benchmark** `scripts/context-engine-v2-benchmark.js` — BEFORE/AFTER decision
  quality + cost.
- Full suite green.

## Review round 2 (blockers 3–6 fixed + live harness)

- **3 Entity recency/cap/dedupe:** entities are deduped by `type+ref` (newer wins,
  fields merged), sorted newest-first BEFORE the cap (the newest is never dropped),
  and a stale V1 `active_entity` no longer overrides a newer V2 entity.
- **4 Memory recency:** `capMemories` and `selectRelevantMemories` break value/
  relevance ties by RECENCY (`last_updated` numeric/ISO, else insertion index) —
  a new high-value memory is never dropped for an equally-valued stale one.
- **5 Strict budget:** the block length is ALWAYS `<= maxChars` (skip, don't
  `break`, on oversized sections; whole-line hard trim as a safety net).
- **6 Extraction output budget:** `compactStateForExtraction` bounds the prompt
  (relevant memories + newest entities), `max_tokens` is computed (700..1200), and
  `mergePreservedMemories` re-attaches older memories so nothing is silently lost.

### Live verification (`scripts/context-engine-v2-live.js`)

Runs REAL conversations through the whole path — real extraction model → state →
context block → pricing → real main reply model → validators + deterministic
escalation + `prepareEscalation` → the FINAL customer text. No hand-built state.
Covers the payment failure (item 2) and reference scenarios A–H (item 7), prints
PII-scrubbed output + extraction success / latency. Needs a STAGING provider key
(`CONTEXT_LIVE_OPENAI_API_KEY` | `_OPENROUTER_` | `_GOOGLE_`, or
`CONTEXT_LIVE_CONFIG`). **With no key it prints BLOCKED for every live item and
never a false PASS.** The offline replay is the deterministic plumbing proof only.

## Rollout

Code + tests + scripts only. **No feature flag, Railway env, or production
change.** Activation of `CONVERSATION_STATE_ENABLED` is a post-review decision
after the live staging replay + latency benchmark (existing
`scripts/benchmark-state-extraction.js`).

## Out of scope

Salla, CRM, UI, vector DB, new provider, payment execution, campaigns, any
architecture rewrite.
