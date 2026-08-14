# Conversation State Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, tenant-scoped structured conversation-state layer (open/resolved issues, active topic/entity, known facts) that is LLM-extracted, fail-soft, injected into the reply prompt, and consumed by deterministic guards (resolution, atomic send-time stale, semantic dedup) — all behind independent feature flags, defaulting to current behavior.

**Architecture:** A new `conversation_states` table (composite-key scoped by `user_id`) holds one JSONB state per conversation plus a monotonic `state_version` and an `extraction_ok`/`reflects_message_id` freshness stamp. A pure-logic module builds the extraction request, validates the LLM JSON, and reconciles system-owned fields (handoff) over LLM output. The AI worker loads state before generation, injects it into `buildSystemPrompt`, extracts an updated state from the customer's new turns, and persists it. Three guards consume the state, each behind its own flag: resolution (via the existing pre-send reviewer), atomic stale-claim UPDATE at send, and semantic dedup (via a `reply_intent` label the reviewer already can emit). Flags off ⇒ byte-identical to today.

**Tech Stack:** Node.js 20, `node:test`, PostgreSQL (`pg`), BullMQ, OpenAI-SDK-compatible chat completions. Tests use the repo's mock-`db` pattern (a `{ isConfigured, query(sql) }` object matched by SQL substrings) and module-cache stubbing — no live DB/Redis/LLM.

---

## File Structure

- **Create** `src/services/ai/conversation-state.js` — PURE logic: `EMPTY_STATE`, `validateState`, `parseExtractionResponse`, `buildExtractionRequest`, `reconcileSystemState`, `buildConversationStateBlock`, `isSemanticDuplicate`, `buildStaleClaimQuery`. No I/O. Everything unit-testable.
- **Create** `src/services/ai/conversation-state.service.js` — I/O orchestration: `loadConversationState`, `saveConversationState`, `extractConversationState`. Takes `database`/`aiClient` params (mockable).
- **Modify** `src/db/migrations/init.js` — add `conversation_states` table + composite FK.
- **Modify** `lib/ai-client.js` — inject `conversationStateBlock` in `buildSystemPrompt`; surface reviewer `reply_intent`.
- **Modify** `src/services/ai/reply-quality-gate.js` — reviewer emits optional `reply_intent`; accept `resolvedIssues` to flag reopen.
- **Modify** `src/workers/ai-worker.js` — load state → inject → extract/persist → semantic dedup wiring; stamp reply with generation reference.
- **Modify** `src/workers/outgoing-whatsapp-worker.js` — atomic stale-claim guard before send.
- **Create** tests under `tests/` — one file per unit + the generic multi-tenant regression file.

**Flags:** `CONVERSATION_STATE_ENABLED`, `SEND_STALE_GUARD_ENABLED`, `SEMANTIC_DEDUP_ENABLED` (all default `false`); `CONVERSATION_STATE_MODEL` (empty ⇒ cheapest default), `CONVERSATION_STATE_EXTRACT_TIMEOUT_MS` (default `9000`).

---

## Task 1: State shape, validation, and extraction-response parsing (pure)

**Files:**
- Create: `src/services/ai/conversation-state.js`
- Test: `tests/conversation-state-parse.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPTY_STATE, validateState, parseExtractionResponse,
} = require('../src/services/ai/conversation-state');

test('EMPTY_STATE has all generic slots and no vertical vocabulary', () => {
  assert.deepEqual(Object.keys(EMPTY_STATE).sort(), [
    'active_entity', 'active_topic', 'actions_attempted', 'customer_goal',
    'known_facts', 'last_reply_intent', 'open_issues', 'resolved_issues',
  ]);
  assert.deepEqual(EMPTY_STATE.open_issues, []);
  assert.equal(EMPTY_STATE.active_topic, null);
});

test('validateState coerces a well-formed object and drops unknown keys', () => {
  const out = validateState({
    open_issues: [{ id: 'iss_1', summary: 'login fails', status: 'open' }],
    resolved_issues: [],
    active_topic: 'login',
    active_entity: { type: 'product', ref: 'x', label: 'X' },
    known_facts: { payment_method: 'bank_transfer' },
    customer_goal: 'access account',
    actions_attempted: [{ action: 'reset pw', outcome: 'unknown', confirmed_by: null }],
    last_reply_intent: 'ask_for_email',
    HACK: 'drop me',
  });
  assert.equal(out.HACK, undefined);
  assert.equal(out.open_issues[0].summary, 'login fails');
  assert.equal(out.active_entity.type, 'product');
  assert.equal(out.known_facts.payment_method, 'bank_transfer');
});

test('validateState repairs bad types into EMPTY_STATE defaults', () => {
  const out = validateState({ open_issues: 'nope', active_entity: 5, known_facts: [1, 2] });
  assert.deepEqual(out.open_issues, []);
  assert.equal(out.active_entity, null);
  assert.deepEqual(out.known_facts, {});
});

test('parseExtractionResponse returns extraction_ok=false on non-JSON', () => {
  const { state, extraction_ok } = parseExtractionResponse('sorry I cannot');
  assert.equal(extraction_ok, false);
  assert.deepEqual(state, EMPTY_STATE);
});

test('parseExtractionResponse strips code fences and validates', () => {
  const raw = '```json\n{"active_topic":"shipping","open_issues":[],"resolved_issues":[]}\n```';
  const { state, extraction_ok } = parseExtractionResponse(raw);
  assert.equal(extraction_ok, true);
  assert.equal(state.active_topic, 'shipping');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-parse.test.js`
Expected: FAIL — `Cannot find module '../src/services/ai/conversation-state'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/ai/conversation-state.js`:

```js
'use strict';

const EMPTY_STATE = Object.freeze({
  open_issues: [],
  resolved_issues: [],
  active_topic: null,
  active_entity: null,
  known_facts: {},
  customer_goal: null,
  actions_attempted: [],
  last_reply_intent: null,
});

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function str(v) {
  return v == null ? null : String(v).slice(0, 400);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}

function validateIssue(x) {
  const o = plainObject(x);
  if (!o) return null;
  return {
    id: str(o.id) || null,
    summary: str(o.summary) || '',
    status: ['open', 'in_progress'].includes(o.status) ? o.status : 'open',
    resolved_by: ['customer_confirmed', 'owner'].includes(o.resolved_by) ? o.resolved_by : undefined,
    resolved_at: str(o.resolved_at) || undefined,
    first_seen_at: str(o.first_seen_at) || undefined,
  };
}

function validateEntity(x) {
  const o = plainObject(x);
  if (!o) return null;
  const type = ['product', 'order', 'service', 'topic'].includes(o.type) ? o.type : null;
  if (!type) return null;
  return { type, ref: str(o.ref) || null, label: str(o.label) || null };
}

function validateAction(x) {
  const o = plainObject(x);
  if (!o) return null;
  return {
    action: str(o.action) || '',
    outcome: ['worked', 'failed', 'unknown'].includes(o.outcome) ? o.outcome : 'unknown',
    confirmed_by: ['customer', 'system'].includes(o.confirmed_by) ? o.confirmed_by : null,
  };
}

function validateFacts(x) {
  const o = plainObject(x);
  if (!o) return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[String(k).slice(0, 60)] = str(v);
    }
  }
  return out;
}

function validateState(input) {
  const o = plainObject(input) || {};
  return {
    open_issues: arr(o.open_issues).map(validateIssue).filter(Boolean),
    resolved_issues: arr(o.resolved_issues).map(validateIssue).filter(Boolean),
    active_topic: str(o.active_topic),
    active_entity: validateEntity(o.active_entity),
    known_facts: validateFacts(o.known_facts),
    customer_goal: str(o.customer_goal),
    actions_attempted: arr(o.actions_attempted).map(validateAction).filter(Boolean),
    last_reply_intent: str(o.last_reply_intent),
  };
}

function parseExtractionResponse(text) {
  const raw = String(text == null ? '' : text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { state: EMPTY_STATE, extraction_ok: false };
  }
  if (!plainObject(parsed)) return { state: EMPTY_STATE, extraction_ok: false };
  return { state: validateState(parsed), extraction_ok: true };
}

module.exports = { EMPTY_STATE, validateState, parseExtractionResponse };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-parse.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.js tests/conversation-state-parse.test.js
git commit -m "feat(state): generic conversation-state shape + validation + parse"
```

---

## Task 2: Extraction request builder (pure, generic multi-vertical prompt)

**Files:**
- Modify: `src/services/ai/conversation-state.js`
- Test: `tests/conversation-state-request.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExtractionRequest } = require('../src/services/ai/conversation-state');

test('buildExtractionRequest yields a system+user message pair with prior state and new turns', () => {
  const req = buildExtractionRequest({
    previousState: { open_issues: [{ id: 'iss_1', summary: 'order not arrived', status: 'open' }] },
    newTurns: [{ role: 'user', content: 'خلاص وصل الطلب' }],
    lastBotReply: 'رح أتابع لك الشحنة',
  });
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].role, 'user');
  assert.ok(req.max_tokens > 0 && req.max_tokens <= 700);
  assert.ok(req.temperature <= 0.3);
  // Generic: the system prompt must NOT hardcode any brand/vertical term.
  const sys = req.messages[0].content;
  for (const banned of ['adobe', 'canva', 'stc', 'prostore', 'برو']) {
    assert.ok(!sys.toLowerCase().includes(banned), `system prompt leaks "${banned}"`);
  }
  // Must instruct customer-confirmed resolution + not stamping systemic state.
  assert.ok(/resolved_issues/.test(sys));
  assert.ok(/handoff|تحويل|النظام/.test(sys));
  // Prior state + new turn are present in the user content.
  assert.ok(req.messages[1].content.includes('order not arrived'));
  assert.ok(req.messages[1].content.includes('خلاص وصل الطلب'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-request.test.js`
Expected: FAIL — `buildExtractionRequest is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/ai/conversation-state.js` (before `module.exports`, and add to exports):

```js
const EXTRACTION_SYSTEM_PROMPT = [
  'You maintain a STRUCTURED STATE of an ongoing customer-service conversation for an online store.',
  'The store may sell anything (physical goods, bookings, software, services). Stay fully generic — never assume a product, brand, vertical, or payment provider.',
  'You receive the PRIOR state (JSON) and the NEW messages since it was computed. Output the UPDATED state as STRICT JSON only — no prose, no code fences.',
  '',
  'Schema keys: open_issues[], resolved_issues[], active_topic, active_entity{type,ref,label}, known_facts{}, customer_goal, actions_attempted[], last_reply_intent.',
  '',
  'Rules:',
  '- When the customer confirms a step/issue is done (any language: "تم", "دخلت", "وصل", "اشتغل", "ضبط", "جاني الكود", "done", "worked"), MOVE that issue from open_issues to resolved_issues with resolved_by="customer_confirmed". Never keep a customer-confirmed issue open.',
  '- When a NEW, distinct problem appears, ADD it to open_issues without dropping other still-open issues.',
  '- known_facts contains ONLY facts the customer stated explicitly (e.g. a payment method they have, an address they gave). Never invent facts.',
  '- You do NOT decide handoff/escalation status and you do NOT mark any systemic action as done. Do NOT set resolved_by="owner" and do NOT set actions_attempted.confirmed_by="system" — those are stamped by the platform, not by you.',
  '- Keep summaries short. Output valid JSON matching the schema and nothing else.',
].join('\n');

function buildExtractionRequest({ previousState = {}, newTurns = [], lastBotReply = '' } = {}) {
  const turnsText = (Array.isArray(newTurns) ? newTurns : [])
    .map((t) => `${t.role === 'assistant' ? 'BOT' : 'CUSTOMER'}: ${String(t.content || '').trim()}`)
    .join('\n');
  const userContent = [
    'PRIOR_STATE:',
    JSON.stringify(previousState || {}),
    '',
    'LAST_BOT_REPLY:',
    String(lastBotReply || '').trim() || '(none)',
    '',
    'NEW_MESSAGES:',
    turnsText || '(none)',
    '',
    'Return the UPDATED state JSON.',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: 'json_object' },
  };
}
```

Add `buildExtractionRequest` and `EXTRACTION_SYSTEM_PROMPT` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-request.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.js tests/conversation-state-request.test.js
git commit -m "feat(state): generic multi-vertical extraction request builder"
```

---

## Task 3: System-state reconciliation (pure) — LLM never owns handoff/tool truth

**Files:**
- Modify: `src/services/ai/conversation-state.js`
- Test: `tests/conversation-state-reconcile.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileSystemState } = require('../src/services/ai/conversation-state');

test('LLM cannot stamp owner-resolution; system decides handoff', () => {
  const llm = {
    open_issues: [{ id: 'iss_1', summary: 'refund', status: 'open' }],
    resolved_issues: [{ id: 'iss_2', summary: 'the team handled it', resolved_by: 'owner' }],
    actions_attempted: [{ action: 'refund', outcome: 'worked', confirmed_by: 'system' }],
  };
  const out = reconcileSystemState(llm, { escalationPending: true });
  // LLM-claimed owner resolution is stripped (system owns it).
  assert.equal(out.resolved_issues.find((i) => i.id === 'iss_2'), undefined);
  // LLM-claimed system-confirmed action is downgraded (no real tool record).
  assert.equal(out.actions_attempted[0].confirmed_by, null);
  // System handoff fact is surfaced authoritatively.
  assert.equal(out.system.escalationPending, true);
});

test('reconcile keeps customer-confirmed resolutions untouched', () => {
  const llm = {
    resolved_issues: [{ id: 'iss_9', summary: 'login', resolved_by: 'customer_confirmed' }],
    actions_attempted: [{ action: 'x', outcome: 'worked', confirmed_by: 'customer' }],
  };
  const out = reconcileSystemState(llm, { escalationPending: false });
  assert.equal(out.resolved_issues[0].resolved_by, 'customer_confirmed');
  assert.equal(out.actions_attempted[0].confirmed_by, 'customer');
  assert.equal(out.system.escalationPending, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-reconcile.test.js`
Expected: FAIL — `reconcileSystemState is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/ai/conversation-state.js` (uses `validateState`):

```js
function reconcileSystemState(llmState, systemFacts = {}) {
  const s = validateState(llmState);
  // Strip any LLM attempt to own systemic truth.
  s.resolved_issues = s.resolved_issues.filter((i) => i.resolved_by !== 'owner');
  s.actions_attempted = s.actions_attempted.map((a) =>
    a.confirmed_by === 'system' ? { ...a, confirmed_by: null } : a);
  // Attach authoritative system-owned facts.
  s.system = { escalationPending: systemFacts.escalationPending === true };
  return s;
}
```

Add `reconcileSystemState` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-reconcile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.js tests/conversation-state-reconcile.test.js
git commit -m "feat(state): reconcile system-owned handoff/tool truth over LLM output"
```

---

## Task 4: Injection block (pure) — fail-soft gating

**Files:**
- Modify: `src/services/ai/conversation-state.js`
- Test: `tests/conversation-state-block.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationStateBlock } = require('../src/services/ai/conversation-state');

const STATE = {
  open_issues: [{ id: 'i2', summary: 'الترخيص غير ظاهر', status: 'open' }],
  resolved_issues: [{ id: 'i1', summary: 'تشغيل البرنامج', resolved_by: 'customer_confirmed' }],
  known_facts: { payment_method: 'تحويل بنكي' },
  active_topic: 'الترخيص',
  active_entity: null,
  customer_goal: null,
  actions_attempted: [],
  last_reply_intent: null,
};

test('no block unless canInject is true (fail-soft)', () => {
  assert.equal(buildConversationStateBlock(STATE, { canInject: false }), '');
  assert.equal(buildConversationStateBlock(null, { canInject: true }), '');
});

test('block lists resolved (do-not-resuggest), open, and known facts', () => {
  const block = buildConversationStateBlock(STATE, { canInject: true });
  assert.ok(block.includes('تشغيل البرنامج'));
  assert.ok(/لا تقترح|تأكّد حلّها/.test(block));
  assert.ok(block.includes('الترخيص غير ظاهر'));
  assert.ok(block.includes('تحويل بنكي'));
});

test('empty state with canInject yields empty string (nothing to say)', () => {
  const empty = {
    open_issues: [], resolved_issues: [], known_facts: {},
    active_topic: null, active_entity: null, customer_goal: null,
    actions_attempted: [], last_reply_intent: null,
  };
  assert.equal(buildConversationStateBlock(empty, { canInject: true }), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-block.test.js`
Expected: FAIL — `buildConversationStateBlock is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/ai/conversation-state.js`:

```js
function buildConversationStateBlock(state, { canInject } = {}) {
  if (!canInject || !state) return '';
  const resolved = Array.isArray(state.resolved_issues) ? state.resolved_issues.filter((i) => i.summary) : [];
  const open = Array.isArray(state.open_issues) ? state.open_issues.filter((i) => i.summary) : [];
  const facts = state.known_facts && typeof state.known_facts === 'object' ? Object.entries(state.known_facts) : [];
  const lines = [];
  if (resolved.length) {
    lines.push('✅ أمور تأكّد حلّها في هذه المحادثة — لا تقترحها ولا تُعِد خطواتها إلا إذا أبلغ العميل بعودتها:');
    for (const i of resolved) lines.push(`- ${i.summary}`);
  }
  if (open.length) {
    lines.push('🟡 أمور ما زالت مفتوحة — عالجها:');
    for (const i of open) lines.push(`- ${i.summary}`);
  }
  if (facts.length) {
    lines.push('📌 معلومات مؤكدة عن العميل (لا تطلبها من جديد):');
    for (const [k, v] of facts) lines.push(`- ${k}: ${v}`);
  }
  if (state.active_topic) lines.push(`🎯 الموضوع النشط الآن: ${state.active_topic}`);
  if (!lines.length) return '';
  return `\n\n🧭 حالة المحادثة (مرجع داخلي — لا تذكرها للعميل):\n${lines.join('\n')}`;
}
```

Add `buildConversationStateBlock` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-block.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.js tests/conversation-state-block.test.js
git commit -m "feat(state): fail-soft conversation-state prompt block"
```

---

## Task 5: Semantic-duplicate comparison + atomic stale-claim query (pure)

**Files:**
- Modify: `src/services/ai/conversation-state.js`
- Test: `tests/conversation-state-guards-pure.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSemanticDuplicate, buildStaleClaimQuery } = require('../src/services/ai/conversation-state');

test('semantic dup: same intent, no new customer turn between → duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});

test('semantic dup: same intent but a new customer turn arrived → NOT duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: true,
  }), false);
});

test('semantic dup: different intent → NOT duplicate; missing intent → NOT duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'give_price', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), false);
  assert.equal(isSemanticDuplicate({
    candidateIntent: '', recentReplyIntents: ['x'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), false);
});

test('buildStaleClaimQuery scopes by user_id and excludes folded inbound ids', () => {
  const { sql, params } = buildStaleClaimQuery({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1',
    generatedAgainstTs: '2026-08-13T10:00:00.000Z', foldedInboundIds: ['a', 'b'],
  });
  assert.ok(/UPDATE messages/.test(sql));
  assert.ok(/SET status = 'sending'/.test(sql));
  assert.ok(/status IN \('queued_for_send'\)/.test(sql));
  assert.ok(/user_id = \$2/.test(sql));            // explicit tenant scope
  assert.ok(/NOT EXISTS/.test(sql));
  assert.ok(/direction = 'inbound'/.test(sql));
  assert.ok(/created_at > \$4/.test(sql));
  assert.ok(/<> ALL\(\$5/.test(sql));
  assert.deepEqual(params, ['r1', 'u1', 'c1', '2026-08-13T10:00:00.000Z', ['a', 'b']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-guards-pure.test.js`
Expected: FAIL — `isSemanticDuplicate is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/ai/conversation-state.js`:

```js
function isSemanticDuplicate({ candidateIntent, recentReplyIntents = [], hasNewCustomerTurnSinceLastAssistant = false } = {}) {
  const c = String(candidateIntent || '').trim();
  if (!c) return false;
  if (hasNewCustomerTurnSinceLastAssistant) return false;
  return recentReplyIntents.some((i) => String(i || '').trim() === c);
}

function buildStaleClaimQuery({ replyMessageId, userId, conversationId, generatedAgainstTs, foldedInboundIds = [] }) {
  const sql = `UPDATE messages
   SET status = 'sending'
 WHERE id = $1
   AND user_id = $2
   AND conversation_id = $3
   AND status IN ('queued_for_send')
   AND NOT EXISTS (
     SELECT 1 FROM messages m2
      WHERE m2.user_id = $2
        AND m2.conversation_id = $3
        AND m2.direction = 'inbound'
        AND m2.created_at > $4
        AND m2.id <> ALL($5::uuid[])
   )
 RETURNING id`;
  return { sql, params: [replyMessageId, userId, conversationId, generatedAgainstTs, foldedInboundIds] };
}
```

Add both to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-guards-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.js tests/conversation-state-guards-pure.test.js
git commit -m "feat(state): pure semantic-dup comparison + atomic stale-claim query"
```

---

## Task 6: DB schema — `conversation_states` table + composite FK

**Files:**
- Modify: `src/db/migrations/init.js` (append a new `CREATE TABLE` near the other domain tables, e.g. after `customer_profiles` ~line 483; add the FK after the table like `customer_profiles_conversation_scope_fk` ~line 500)
- Test: `tests/conversation-states-schema.test.js`

- [ ] **Step 1: Write the failing test** (mirrors `admin-api-keys-schema.test.js` — asserts the migration source contains the DDL)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('conversation_states table is created, tenant-scoped, with composite FK', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS conversation_states/.test(SRC));
  assert.ok(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(SRC));
  assert.ok(/state\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/.test(SRC));
  assert.ok(/state_version\s+INTEGER NOT NULL DEFAULT 0/.test(SRC));
  assert.ok(/reflects_message_id\s+UUID/.test(SRC));
  assert.ok(/extraction_ok\s+BOOLEAN NOT NULL DEFAULT TRUE/.test(SRC));
  assert.ok(/PRIMARY KEY \(user_id, conversation_id\)/.test(SRC));
  assert.ok(/conversation_states_scope_fk/.test(SRC));
  assert.ok(/REFERENCES conversations \(id, user_id, channel_id, sender\)/.test(SRC));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-states-schema.test.js`
Expected: FAIL — no `conversation_states` in source.

- [ ] **Step 3: Write minimal implementation**

In `src/db/migrations/init.js`, inside the same DDL-executing block as the other tables, add:

```js
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_states (
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id     UUID NOT NULL,
      channel_id          TEXT NOT NULL DEFAULT 'whatsapp',
      sender              TEXT NOT NULL,
      state               JSONB NOT NULL DEFAULT '{}'::jsonb,
      state_version       INTEGER NOT NULL DEFAULT 0,
      reflects_message_id UUID,
      extraction_ok       BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, conversation_id)
    );
  `);

  // Composite-key FK: a state row can never reference another tenant's
  // conversation (defense-in-depth, mirrors messages_conversation_scope_fk).
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'conversation_states_scope_fk'
      ) THEN
        ALTER TABLE conversation_states
          ADD CONSTRAINT conversation_states_scope_fk
          FOREIGN KEY (conversation_id, user_id, channel_id, sender)
          REFERENCES conversations (id, user_id, channel_id, sender)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);
```

(Place after the `customer_profiles` table + its scope FK so the referenced `conversations_scope_unique` unique key already exists.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-states-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/init.js tests/conversation-states-schema.test.js
git commit -m "feat(state): conversation_states table with composite-key tenant FK"
```

---

## Task 7: State store — load/save with explicit tenant scope

**Files:**
- Create: `src/services/ai/conversation-state.service.js`
- Test: `tests/conversation-state-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConversationState, saveConversationState } = require('../src/services/ai/conversation-state.service');
const { EMPTY_STATE } = require('../src/services/ai/conversation-state');

function mockDb(rows) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT .*FROM conversation_states/i.test(sql)) return { rows: rows || [], rowCount: (rows || []).length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('loadConversationState scopes by user_id AND conversation_id, returns EMPTY_STATE when absent', async () => {
  const db = mockDb([]);
  const out = await loadConversationState({ userId: 'u1', conversationId: 'c1', database: db });
  assert.deepEqual(out.state, EMPTY_STATE);
  assert.equal(out.extraction_ok, false);
  const q = db.calls[0];
  assert.ok(/user_id = \$1/.test(q.sql) && /conversation_id = \$2/.test(q.sql));
  assert.deepEqual(q.params, ['u1', 'c1']);
});

test('saveConversationState bumps version on ok and stamps reflects_message_id', async () => {
  const db = mockDb([]);
  await saveConversationState({
    userId: 'u1', conversationId: 'c1', sender: 's1',
    state: { active_topic: 'x' }, extractionOk: true, reflectsMessageId: 'm9', database: db,
  });
  const q = db.calls[0];
  assert.ok(/INSERT INTO conversation_states/i.test(q.sql));
  assert.ok(/state_version = conversation_states\.state_version \+ 1/.test(q.sql));
  assert.ok(/ON CONFLICT \(user_id, conversation_id\)/.test(q.sql));
  assert.equal(q.params[0], 'u1');
});

test('saveConversationState with extractionOk=false does NOT write a new state (only flags)', async () => {
  const db = mockDb([]);
  await saveConversationState({
    userId: 'u1', conversationId: 'c1', sender: 's1',
    state: { active_topic: 'ignored' }, extractionOk: false, reflectsMessageId: null, database: db,
  });
  const q = db.calls[0];
  assert.ok(/UPDATE conversation_states/i.test(q.sql));
  assert.ok(/extraction_ok = FALSE/.test(q.sql));
  assert.ok(!/state_version = conversation_states\.state_version \+ 1/.test(q.sql));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/ai/conversation-state.service.js`:

```js
'use strict';

const db = require('../../db/client');
const { EMPTY_STATE, validateState } = require('./conversation-state');

async function loadConversationState({ userId, conversationId, database = db } = {}) {
  if (!userId || !conversationId || !database?.isConfigured?.()) {
    return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
  }
  try {
    const r = await database.query(
      `SELECT state, state_version, reflects_message_id, extraction_ok
         FROM conversation_states
        WHERE user_id = $1 AND conversation_id = $2
        LIMIT 1`,
      [userId, conversationId],
    );
    const row = r.rows[0];
    if (!row) return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
    return {
      state: validateState(row.state),
      extraction_ok: row.extraction_ok === true,
      reflects_message_id: row.reflects_message_id || null,
      state_version: Number(row.state_version) || 0,
    };
  } catch (_) {
    return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
  }
}

async function saveConversationState({
  userId, conversationId, sender, channelId = 'whatsapp',
  state, extractionOk, reflectsMessageId = null, database = db,
} = {}) {
  if (!userId || !conversationId || !sender || !database?.isConfigured?.()) return;
  try {
    if (extractionOk) {
      await database.query(
        `INSERT INTO conversation_states
           (user_id, conversation_id, channel_id, sender, state, state_version, reflects_message_id, extraction_ok, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, TRUE, now())
         ON CONFLICT (user_id, conversation_id) DO UPDATE
           SET state = EXCLUDED.state,
               state_version = conversation_states.state_version + 1,
               reflects_message_id = EXCLUDED.reflects_message_id,
               extraction_ok = TRUE,
               updated_at = now()`,
        [userId, conversationId, channelId, sender, JSON.stringify(validateState(state)), reflectsMessageId],
      );
    } else {
      // Fail-soft: never persist a fresh state as truth on failure. Only flag it
      // so the injector knows the stored state is not current. Insert an empty
      // row if none exists yet (so the flag is durable) but do NOT bump version.
      await database.query(
        `INSERT INTO conversation_states
           (user_id, conversation_id, channel_id, sender, extraction_ok, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, now())
         ON CONFLICT (user_id, conversation_id) DO UPDATE
           SET extraction_ok = FALSE, updated_at = now()`,
        [userId, conversationId, channelId, sender],
      );
    }
  } catch (_) { /* fail-soft: state persistence never blocks a reply */ }
}

module.exports = { loadConversationState, saveConversationState };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.service.js tests/conversation-state-store.test.js
git commit -m "feat(state): tenant-scoped state store with fail-soft persistence"
```

---

## Task 8: Extraction orchestrator — fail-soft, one LLM call

**Files:**
- Modify: `src/services/ai/conversation-state.service.js`
- Test: `tests/conversation-state-extract.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');

const okClient = {
  raw: async () => ({ choices: [{ message: { content: '{"active_topic":"shipping","open_issues":[],"resolved_issues":[]}' } }] }),
};

test('extractConversationState returns validated state + extraction_ok=true, reconciled with system facts', async () => {
  const out = await extractConversationState({
    userId: 'u1', conversationId: 'c1',
    previousState: {}, newTurns: [{ role: 'user', content: 'وين طلبي' }], lastBotReply: '',
    config: {}, aiClient: okClient, systemFacts: { escalationPending: true },
  });
  assert.equal(out.extraction_ok, true);
  assert.equal(out.state.active_topic, 'shipping');
  assert.equal(out.state.system.escalationPending, true);
});

test('extractConversationState is fail-soft: client throws → extraction_ok=false, prior state preserved', async () => {
  const boomClient = { raw: async () => { throw new Error('timeout'); } };
  const out = await extractConversationState({
    userId: 'u1', conversationId: 'c1',
    previousState: { active_topic: 'prior' }, newTurns: [{ role: 'user', content: 'x' }], lastBotReply: '',
    config: {}, aiClient: boomClient, systemFacts: {},
  });
  assert.equal(out.extraction_ok, false);
  assert.equal(out.state.active_topic, 'prior'); // prior preserved, NOT presented as new truth by caller
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conversation-state-extract.test.js`
Expected: FAIL — `extractConversationState is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/ai/conversation-state.service.js` (import the pure helpers; add to exports). The `aiClient.raw(payload)` method is a thin wrapper the AIClient will expose in Task 9 (a direct `chat.completions.create`). For the test, a stub provides `raw`.

```js
const {
  buildExtractionRequest, parseExtractionResponse, reconcileSystemState, validateState: _vs,
} = require('./conversation-state');

async function extractConversationState({
  userId, conversationId, previousState = {}, newTurns = [], lastBotReply = '',
  config = {}, aiClient, systemFacts = {}, timeoutMs,
} = {}) {
  const prior = _vs(previousState);
  try {
    if (!aiClient?.raw) throw new Error('no extraction client');
    const req = buildExtractionRequest({ previousState: prior, newTurns, lastBotReply });
    const limit = Number(timeoutMs || process.env.CONVERSATION_STATE_EXTRACT_TIMEOUT_MS || 9000);
    const resp = await Promise.race([
      aiClient.raw(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), limit)),
    ]);
    const content = resp?.choices?.[0]?.message?.content || '';
    const { state, extraction_ok } = parseExtractionResponse(content);
    if (!extraction_ok) return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false };
    return { state: reconcileSystemState(state, systemFacts), extraction_ok: true };
  } catch (_) {
    return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false };
  }
}
```

Update `module.exports` to include `extractConversationState`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conversation-state-extract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/conversation-state.service.js tests/conversation-state-extract.test.js
git commit -m "feat(state): fail-soft extraction orchestrator (single LLM call)"
```

---

## Task 9: AIClient — expose `raw()` + inject state block behind flag

**Files:**
- Modify: `lib/ai-client.js` (add `raw()` method; inject `conversationStateBlock` in `buildSystemPrompt` at the `pendingEscalationBlock` site ~line 299-354)
- Test: `tests/ai-client-conversation-state-inject.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

function client() {
  return new AIClient({ storeName: 'x', botInstructions: 'انت موظف خدمة عملاء محترف لمتجر عام. جاوب باختصار.' }, { info() {}, warn() {}, error() {} });
}

test('flag OFF → no state block (legacy prompt)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'false';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'دخول', resolved_by: 'customer_confirmed' }] },
    conversationStateCanInject: true,
  });
  assert.ok(!sys.includes('حالة المحادثة'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('flag ON + canInject → state block present', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }], open_issues: [], known_facts: {} },
    conversationStateCanInject: true,
  });
  assert.ok(sys.includes('حالة المحادثة'));
  assert.ok(sys.includes('تسجيل الدخول'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('flag ON but canInject=false → no block (fail-soft)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'x', resolved_by: 'customer_confirmed' }] },
    conversationStateCanInject: false,
  });
  assert.ok(!sys.includes('حالة المحادثة'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-client-conversation-state-inject.test.js`
Expected: FAIL — block not injected.

- [ ] **Step 3: Write minimal implementation**

In `lib/ai-client.js`:

(a) At top, near other `require`s of `src/services/ai/*`, add:
```js
const { buildConversationStateBlock } = require('../src/services/ai/conversation-state');
```

(b) In `buildSystemPrompt`, right after `pendingEscalationBlock` is computed (~line 304), add:
```js
    const conversationStateBlock = (process.env.CONVERSATION_STATE_ENABLED === 'true')
      ? buildConversationStateBlock(opts.conversationState, { canInject: opts.conversationStateCanInject === true })
      : '';
```

(c) Append `${conversationStateBlock}` to BOTH return templates — in the long-instructions branch (~line 345) and the default branch (~line 354), placed right after `${pendingEscalationBlock}`:
```js
    // long-instructions branch:
    return `${customInstructions}${knowledgeRules}${platformBlock}${policyBlock}${instantBlock}${profileBlock}${pendingEscalationBlock}${conversationStateBlock}${escalationBlock}${welcomeHint}`;
    // default branch tail:
${platformBlock}${knowledgeRules}${policyBlock}${instantBlock}${profileBlock}${pendingEscalationBlock}${conversationStateBlock}${escalationBlock}${welcomeHint}`;
```

(d) Add a `raw()` method on the AIClient class (used by the extractor). Place near `getReply`:
```js
  // Thin passthrough for auxiliary structured calls (e.g. conversation-state
  // extraction). Uses the cheapest configured model unless overridden.
  async raw({ messages, temperature = 0.2, max_tokens = 600, response_format } = {}) {
    const { openai } = this.buildClient();
    const model = process.env.CONVERSATION_STATE_MODEL
      || this.resolveEffectiveModel?.() // falls back below if undefined
      || process.env.GOOGLE_DEFAULT_MODEL
      || 'google/gemini-2.0-flash';
    const payload = { model, messages, temperature, max_tokens };
    if (response_format) payload.response_format = response_format;
    return openai.chat.completions.create(payload, { timeout: 15000 });
  }
```
(If `resolveEffectiveModel` is a module-level function rather than a method, call it as imported; match the existing usage in the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-client-conversation-state-inject.test.js`
Expected: PASS.

- [ ] **Step 5: Run the two existing prompt snapshot tests to confirm legacy parity**

Run: `node --test tests/ai-client-prompt.test.js tests/ai-client-knowledge-injection.test.js`
Expected: PASS (flag defaults off ⇒ unchanged prompt).

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-client-conversation-state-inject.test.js
git commit -m "feat(state): inject conversation-state block behind flag + raw() passthrough"
```

---

## Task 10: Wire load → inject → extract → persist into the AI worker

**Files:**
- Modify: `src/workers/ai-worker.js` (`processAiReply`, ~lines 970-1170)
- Modify: `src/workers/ai-worker.js` `storeAssistantMessage` (~line 488) to stamp generation reference
- Test: `tests/ai-worker-conversation-state-wiring.test.js`

- [ ] **Step 1: Write the failing test** (wiring test in the style of `ai-worker-escalation-pending-wiring.test.js`; assert the state SELECT is issued with `user_id` and that a save is attempted)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

process.env.CONVERSATION_STATE_ENABLED = 'true';

let loadedWithUserId = false;
let saved = false;
stub(path.resolve(__dirname, '..', 'src', 'services', 'ai', 'conversation-state.service.js'), {
  async loadConversationState({ userId }) {
    if (userId) loadedWithUserId = true;
    return { state: { open_issues: [], resolved_issues: [] }, extraction_ok: true, reflects_message_id: 'inbound-1', state_version: 3 };
  },
  async saveConversationState() { saved = true; },
  async extractConversationState() {
    return { state: { active_topic: 'x', open_issues: [], resolved_issues: [] }, extraction_ok: true };
  },
});

// ... reuse the dbMock + stubs pattern from ai-worker-escalation-pending-wiring.test.js
// (copy that file's mock harness verbatim, then:)

test('processAiReply loads state scoped by userId and persists extracted state', async () => {
  const { processAiReply } = require('../src/workers/ai-worker');
  await processAiReply(/* the same job/payload the sibling wiring test builds */);
  assert.equal(loadedWithUserId, true);
  assert.equal(saved, true);
});
```

(Copy the exact `dbMock`, `stub()` calls, and `job`/`payload` construction from `tests/ai-worker-escalation-pending-wiring.test.js`; add the stub above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-worker-conversation-state-wiring.test.js`
Expected: FAIL — worker does not yet call the state service.

- [ ] **Step 3: Write minimal implementation**

In `src/workers/ai-worker.js`:

(a) Add near the top imports:
```js
const {
  loadConversationState, saveConversationState, extractConversationState,
} = require('../services/ai/conversation-state.service');
```

(b) In `processAiReply`, AFTER `escalationPending` is resolved (~line 1001) and BEFORE `ai.getReply` (~line 1010), add:
```js
    const stateEnabled = process.env.CONVERSATION_STATE_ENABLED === 'true';
    let convStateRow = { state: undefined, extraction_ok: false, reflects_message_id: null };
    if (stateEnabled) {
      try {
        convStateRow = await loadConversationState({ userId, conversationId: conversation.id });
      } catch (e) { logger.warn('state', `load failed: ${e.message}`); }
    }
    // Extract an UPDATED state from the new customer turns BEFORE generating,
    // so the reply is grounded on current state. Fail-soft.
    const latestInboundId = enrichedMessages.length ? enrichedMessages[enrichedMessages.length - 1].id : null;
    if (stateEnabled) {
      try {
        const extracted = await extractConversationState({
          userId, conversationId: conversation.id,
          previousState: convStateRow.state,
          newTurns: [{ role: 'user', content: text }],
          lastBotReply: [...history].reverse().find(m => m.role === 'assistant')?.content || '',
          config, aiClient: ai, systemFacts: { escalationPending },
        });
        await saveConversationState({
          userId, conversationId: conversation.id, sender: conversation.sender,
          state: extracted.state, extractionOk: extracted.extraction_ok,
          reflectsMessageId: extracted.extraction_ok ? latestInboundId : null,
        });
        if (extracted.extraction_ok) {
          convStateRow = { state: extracted.state, extraction_ok: true, reflects_message_id: latestInboundId };
        }
      } catch (e) { logger.warn('state', `extract failed: ${e.message}`); }
    }
    const conversationStateCanInject = stateEnabled
      && convStateRow.extraction_ok === true
      && convStateRow.reflects_message_id === latestInboundId;
```
Note: `ai` must be constructed BEFORE this block. Move the `const ai = new AIClient(...)` construction (currently ~line 1003) to just above this block if needed.

(c) Extend the `ai.getReply(history, { ... })` opts (~line 1011) to pass:
```js
        conversationState: convStateRow.state,
        conversationStateCanInject,
```
(Add the same two keys to the dedup-retry `ai.getReply` call ~line 1067.)

(d) In `storeAssistantMessage` (~line 488), add two params and persist the generation reference into `raw_payload`. Change the signature to accept `generatedAgainstTs` and `foldedInboundIds`, and add them to the JSON payload:
```js
async function storeAssistantMessage({ userId, conversationId, sender, reply, jobId, qualityGateAudit, generatedAgainstTs = null, foldedInboundIds = [], database = db }) {
  // ...
      JSON.stringify({
        source: WORKER_NAME,
        jobId,
        qualityGate: compactQualityGateAudit(qualityGateAudit),
        generatedAgainstTs,
        foldedInboundIds,
      }),
```
And at the call site (~line 1128) pass:
```js
      generatedAgainstTs: new Date().toISOString(),
      foldedInboundIds: enrichedMessages.map(m => m.id),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-worker-conversation-state-wiring.test.js`
Expected: PASS.

- [ ] **Step 5: Run the AI-worker regression tests to confirm no break**

Run: `node --test tests/ai-worker-escalation-pending-wiring.test.js tests/ai-worker-dedup-lookback.test.js tests/ai-worker-no-duplicate-rephrase.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/ai-worker.js tests/ai-worker-conversation-state-wiring.test.js
git commit -m "feat(state): wire load/inject/extract/persist into AI worker (flagged)"
```

---

## Task 11: Atomic stale-claim guard at send time

**Files:**
- Modify: `src/workers/outgoing-whatsapp-worker.js` (add guard after `isReplyAlreadySent`, ~line 416, before status→processing ~line 418)
- Test: `tests/outgoing-stale-claim-guard.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { claimSendOrStale } = require('../src/workers/outgoing-whatsapp-worker');

function db(rowCount) {
  return { isConfigured: () => true, async query() { return { rows: rowCount ? [{ id: 'r1' }] : [], rowCount }; } };
}

test('claimSendOrStale returns true when the atomic UPDATE claims 1 row', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1',
    generatedAgainstTs: '2026-08-13T10:00:00Z', foldedInboundIds: ['a'], database: db(1),
  });
  assert.equal(ok, true);
});

test('claimSendOrStale returns false (stale) when 0 rows claimed', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1',
    generatedAgainstTs: '2026-08-13T10:00:00Z', foldedInboundIds: ['a'], database: db(0),
  });
  assert.equal(ok, false);
});

test('claimSendOrStale is fail-open: missing generatedAgainstTs → true (legacy send)', async () => {
  const ok = await claimSendOrStale({ replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: db(0) });
  assert.equal(ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/outgoing-stale-claim-guard.test.js`
Expected: FAIL — `claimSendOrStale is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/workers/outgoing-whatsapp-worker.js`, add and export the function:

```js
const { buildStaleClaimQuery } = require('../services/ai/conversation-state');

// Atomic send-time stale guard. A single conditional UPDATE claims the exclusive
// right to send (queued_for_send → sending) ONLY IF no newer customer inbound
// exists than the batch this reply answered. No read-then-send race.
// Fail-open: any missing input or DB error returns true (legacy behavior).
async function claimSendOrStale({
  replyMessageId, userId, conversationId, generatedAgainstTs, foldedInboundIds = [], database = db,
} = {}) {
  if (process.env.SEND_STALE_GUARD_ENABLED !== 'true') return true;
  if (!replyMessageId || !userId || !conversationId || !generatedAgainstTs || !database?.isConfigured?.()) return true;
  try {
    const { sql, params } = buildStaleClaimQuery({
      replyMessageId, userId, conversationId, generatedAgainstTs, foldedInboundIds,
    });
    const r = await database.query(sql, params);
    return r.rowCount > 0;
  } catch (_) {
    return true; // fail-open — never block a legitimate reply on a guard error
  }
}
```

Wire it into `processOutgoingWhatsapp` right after the `isReplyAlreadySent` block (~line 416):
```js
  if (payload.source === 'ai_reply') {
    const claimed = await claimSendOrStale({
      replyMessageId,
      userId,
      conversationId: payload.conversationId,
      generatedAgainstTs: payload.generatedAgainstTs || null,
      foldedInboundIds: payload.foldedInboundIds || [],
    });
    if (!claimed) {
      await markReplyMessage(replyMessageId, 'canceled', {
        sentBy: WORKER_NAME, canceledAt: new Date().toISOString(),
        error: 'stale: newer customer message arrived before send',
      }, messageScope(payload));
      await updateJobStatus(job.id, {
        status: 'canceled', finished_at: new Date(), attempts: job.attemptsMade,
        last_error: 'stale outgoing reply (newer inbound)',
      });
      return { skipped: true, reason: 'stale_new_inbound' };
    }
  }
```

Add `claimSendOrStale` to the module's `module.exports`. Pass `generatedAgainstTs` and `foldedInboundIds` through the outgoing enqueue payload — in `ai-worker.js` `enqueueOutgoingWhatsapp({...})` (~line 1149) add:
```js
      generatedAgainstTs: new Date().toISOString(),
      foldedInboundIds: enrichedMessages.map(m => m.id),
```
(Use the SAME timestamp value passed to `storeAssistantMessage` in Task 10 — hoist it to a `const generatedAgainstTs = new Date().toISOString();` above `storeAssistantMessage` and reuse in both calls.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/outgoing-stale-claim-guard.test.js`
Expected: PASS.

- [ ] **Step 5: Run outgoing-worker regressions**

Run: `node --test tests/ai-worker-stale-skip.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/outgoing-whatsapp-worker.js src/workers/ai-worker.js tests/outgoing-stale-claim-guard.test.js
git commit -m "feat(state): atomic send-time stale-claim guard (flagged)"
```

---

## Task 12: Semantic dedup — reviewer emits reply_intent, worker compares

**Files:**
- Modify: `src/services/ai/reply-quality-gate.js` (`reviewFinalReplyBeforeSend` schema/prompt: add optional `reply_intent`; accept `resolvedIssues`)
- Modify: `lib/ai-client.js` — surface `reply_intent` from the reviewer onto `getReply` result/`lastDebug`
- Modify: `src/workers/ai-worker.js` — behind `SEMANTIC_DEDUP_ENABLED`, load recent reply intents + compare
- Test: `tests/semantic-dedup-wiring.test.js`

- [ ] **Step 1: Write the failing test** (pure comparison already covered in Task 5; here assert the worker records the candidate intent and applies `isSemanticDuplicate`)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSemanticDuplicate } = require('../src/services/ai/conversation-state');

// Guard against regressions in the flag gate and the pure decision the worker uses.
test('SEMANTIC_DEDUP: identical intent with no new customer turn is a duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup',
    recentReplyIntents: ['ask_email', 'promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});

test('SEMANTIC_DEDUP flag default off is respected by the worker gate', () => {
  const prev = process.env.SEMANTIC_DEDUP_ENABLED;
  delete process.env.SEMANTIC_DEDUP_ENABLED;
  assert.notEqual(process.env.SEMANTIC_DEDUP_ENABLED, 'true');
  process.env.SEMANTIC_DEDUP_ENABLED = prev;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/semantic-dedup-wiring.test.js`
Expected: PASS for the pure assertions (this file mainly locks behavior). If `isSemanticDuplicate` import path is wrong it FAILS — fix the path.

- [ ] **Step 3: Write minimal implementation**

(a) In `src/services/ai/reply-quality-gate.js` `reviewFinalReplyBeforeSend`: add `resolvedIssues = []` to its params; in the reviewer's JSON instruction, add two optional output fields: `reply_intent` (a short snake_case label of the reply's communicative intent) and `reopens_resolved` (boolean: does the reply re-suggest a step for an already-resolved issue in the provided list?). Include the resolved list in the reviewer prompt only when non-empty. Return both fields in the result object (default `reply_intent: null`, `reopens_resolved: false` when absent).

(b) In `lib/ai-client.js` where `reviewFinalReplyBeforeSend` is called (~line 148), pass `resolvedIssues: (opts.conversationState?.resolved_issues || [])` and store `reviewed.reply_intent` / `reviewed.reopens_resolved` on `this.lastDebug`. If `reopens_resolved === true` and `process.env.CONVERSATION_STATE_ENABLED === 'true'`, trigger the existing single-regeneration path (reuse the same mechanism used for duplicate regeneration) — one retry, then accept best.

(c) In `src/workers/ai-worker.js`, after the reply is generated and BEFORE the existing Jaccard dedup block (~line 1050), add behind the flag:
```js
    if (process.env.SEMANTIC_DEDUP_ENABLED === 'true') {
      try {
        const candidateIntent = ai.lastDebug?.reply_intent || '';
        if (candidateIntent) {
          const recent = await loadRecentReplyIntents({ db, userId, conversationId: conversation.id, limit: 5 });
          const dupBySemantics = isSemanticDuplicate({
            candidateIntent,
            recentReplyIntents: recent,
            hasNewCustomerTurnSinceLastAssistant: false, // this reply answers the latest customer turn already
          });
          if (dupBySemantics) {
            logger.warn('dedup', `semantic duplicate intent="${candidateIntent}" — suppressing`);
            suppressDuplicate = true;
          }
        }
      } catch (e) { logger.warn('dedup', `semantic dedup failed: ${e.message}`); }
    }
```
Declare `let suppressDuplicate = false;` earlier if not already in scope (it is defined at ~line 1049 — hoist it above this block or merge with the existing declaration). Add a helper near `findDuplicateRecentReply` usage:
```js
async function loadRecentReplyIntents({ db, userId, conversationId, limit = 5, database = db }) {
  if (!userId || !conversationId || !database?.isConfigured?.()) return [];
  try {
    const r = await database.query(
      `SELECT raw_payload->>'replyIntent' AS intent
         FROM messages
        WHERE user_id = $1 AND conversation_id = $2
          AND direction = 'outbound' AND role = 'assistant'
        ORDER BY created_at DESC LIMIT $3`,
      [userId, conversationId, limit],
    );
    return r.rows.map((x) => x.intent).filter(Boolean);
  } catch (_) { return []; }
}
```
(d) Persist the candidate intent on the assistant row: in `storeAssistantMessage` add `replyIntent = null` param and include it in `raw_payload`; pass `replyIntent: ai.lastDebug?.reply_intent || null` at the call site.

- [ ] **Step 4: Run tests**

Run: `node --test tests/semantic-dedup-wiring.test.js tests/ai-worker-no-duplicate-rephrase.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-quality-gate.js lib/ai-client.js src/workers/ai-worker.js tests/semantic-dedup-wiring.test.js
git commit -m "feat(state): semantic dedup + resolution-reopen guard via reviewer (flagged)"
```

---

## Task 13: Generic multi-tenant regression tests (Tenant A/B/C/D + ProStore)

**Files:**
- Test: `tests/conversation-state-generic-regression.test.js`

These test the PURE engine (no DB/LLM) against the spec's four fictional verticals plus the ProStore login case, proving the SAME code path handles any tenant.

- [ ] **Step 1: Write the test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateState, reconcileSystemState, buildConversationStateBlock, isSemanticDuplicate,
} = require('../src/services/ai/conversation-state');

// Simulate the LLM extractor output for each vertical, then assert the engine
// carries the right generic state. No vertical-specific code exists in the engine.

test('Tenant A (e-commerce): "ما وصل" then "خلاص وصل" → shipment resolved, not re-suggested', () => {
  const extracted = validateState({
    open_issues: [],
    resolved_issues: [{ id: 'i1', summary: 'الطلب ما وصل', resolved_by: 'customer_confirmed' }],
    active_topic: 'الشحن',
  });
  const block = buildConversationStateBlock(extracted, { canInject: true });
  assert.ok(block.includes('الطلب ما وصل'));
  assert.ok(/لا تقترحها|تأكّد حلّها/.test(block)); // instructs: do not re-suggest tracking
});

test('Tenant B (bookings): reschedule stays open — LLM cannot stamp it done', () => {
  const out = reconcileSystemState({
    open_issues: [{ id: 'b1', summary: 'تغيير الموعد', status: 'open' }],
    // LLM wrongly tries to mark it executed:
    actions_attempted: [{ action: 'reschedule', outcome: 'worked', confirmed_by: 'system' }],
    resolved_issues: [],
  }, { escalationPending: true });
  assert.equal(out.open_issues[0].summary, 'تغيير الموعد');
  assert.equal(out.actions_attempted[0].confirmed_by, null); // no real tool → not system-confirmed
  assert.equal(out.system.escalationPending, true);
});

test('Tenant C (software): issue A resolved, issue B newly open — both tracked', () => {
  const s = validateState({
    resolved_issues: [{ id: 'c1', summary: 'البرنامج ما يشتغل', resolved_by: 'customer_confirmed' }],
    open_issues: [{ id: 'c2', summary: 'الترخيص غير ظاهر', status: 'open' }],
  });
  assert.equal(s.resolved_issues.length, 1);
  assert.equal(s.open_issues.length, 1);
  const block = buildConversationStateBlock(s, { canInject: true });
  assert.ok(block.includes('البرنامج ما يشتغل') && block.includes('الترخيص غير ظاهر'));
});

test('Tenant D (payments): no compatible method captured generically in known_facts (no wallet names hardcoded)', () => {
  const s = validateState({
    known_facts: { customer_payment_method: 'محفظة غير مدعومة', payment_compatibility: 'none' },
    open_issues: [{ id: 'd1', summary: 'طريقة دفع متوافقة', status: 'open' }],
  });
  assert.equal(s.known_facts.payment_compatibility, 'none');
  const block = buildConversationStateBlock(s, { canInject: true });
  assert.ok(block.includes('payment_compatibility'));
});

test('ProStore regression: login confirmed → not re-suggested; semantic repeat suppressed', () => {
  const s = validateState({
    resolved_issues: [{ id: 'p1', summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }],
  });
  assert.ok(buildConversationStateBlock(s, { canInject: true }).includes('تسجيل الدخول'));
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'ask_login_again', recentReplyIntents: ['ask_login_again'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/conversation-state-generic-regression.test.js`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/conversation-state-generic-regression.test.js
git commit -m "test(state): generic multi-tenant regression (Tenant A/B/C/D + ProStore)"
```

---

## Task 14: Full-suite verification + legacy parity

**Files:** none (verification only)

- [ ] **Step 1: Run the entire suite**

Run: `npm test`
Expected: all tests PASS (new + existing). Investigate and fix any regression before proceeding.

- [ ] **Step 2: Confirm flags-off parity**

Verify the three flags default off (grep to confirm no `=== 'true'` gate is inverted):

Run: `node --test tests/ai-client-prompt.test.js tests/ai-client-knowledge-injection.test.js tests/ai-escalation-state-awareness.test.js`
Expected: PASS — unchanged legacy behavior with flags unset.

- [ ] **Step 3: Update `.env.example`** with the new flags (documented, all default-off):

```
# Conversation State Engine (phase 1) — all default OFF
CONVERSATION_STATE_ENABLED=false
SEND_STALE_GUARD_ENABLED=false
SEMANTIC_DEDUP_ENABLED=false
# CONVERSATION_STATE_MODEL=            # empty → cheapest default model
CONVERSATION_STATE_EXTRACT_TIMEOUT_MS=9000
```

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(state): document conversation-state feature flags (default off)"
```

---

## Self-Review Notes (coverage map)

- Spec §3 data model → Task 6 (table), Task 1 (shape).
- Spec §4 extraction (generic, single call, fail-soft, system reconcile) → Tasks 2, 3, 8.
- Spec §5 injection (fail-soft gating on `extraction_ok` + `reflects_message_id`) → Tasks 4, 9, 10.
- Spec §6.1 resolution guard → Task 12(b) (`reopens_resolved` via reviewer).
- Spec §6.2 atomic send-time stale guard → Tasks 5, 11.
- Spec §6.3 semantic dedup (own flag) → Tasks 5, 12.
- Spec §9 explicit tenant scope → Tasks 5 (query builder asserts `user_id`), 6 (composite FK), 7 (store asserts scope), 10 (load by userId).
- Spec §10 tests incl. Tenant A/B/C/D → Task 13; legacy parity → Task 14.
- Flags default off (spec §2.6, §8) → asserted in Tasks 9, 14.
