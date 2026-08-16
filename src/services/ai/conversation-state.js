'use strict';

/**
 * Generic, tenant-agnostic conversation-state primitives (PURE — no I/O).
 *
 * The state vocabulary is deliberately abstract: an "issue" is anything
 * (a login, a shipment, a booking, a payment, a subscription, a technical
 * fault) — the engine never knows or encodes a vertical. This module is the
 * single source of the state shape, its validation, the extraction request,
 * system-state reconciliation, the prompt block, and the two deterministic
 * guard helpers. Everything here is synchronous and unit-testable without a
 * database or an LLM.
 */

// Context Engine V2 caps (deterministic bounds — a state must never grow without
// limit; these are the code-level guarantees behind spec §8 and §19).
const MAX_ACTIVE_ENTITIES = 20;
const MAX_RECENT_TOPICS = 12;
const MAX_SALIENT_MEMORIES = 50;
const MAX_RESOLVED_REFERENCES = 12;

// V2 state is a strict SUPERSET of V1: every V1 slot is preserved so old DB rows
// keep working, and the new V2 slots default to empty. `schema_version` marks the
// shape; the renderer keys off content presence, never the version number.
const EMPTY_STATE = Object.freeze({
  schema_version: 2,
  // ── V1 slots (backward compatible) ──
  open_issues: [],
  resolved_issues: [],
  active_topic: null,
  active_entity: null,
  known_facts: {},
  customer_goal: null,
  actions_attempted: [],
  last_reply_intent: null,
  // ── V2 slots ──
  active_entities: [],
  recent_topics: [],
  pending_expectation: null,
  salient_memories: [],
  last_turn_understanding: Object.freeze({
    intent: null,
    resolved_references: [],
    topic_transition: null,
    customer_correction: false,
  }),
});

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function str(v) {
  return v == null ? null : String(v).slice(0, 400);
}
function shortStr(v, n = 120) {
  const s = str(v);
  return s == null ? null : s.slice(0, n);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function confidenceOf(v) {
  return ['high', 'medium', 'low'].includes(v) ? v : null;
}

function validateIssue(x) {
  const o = plainObject(x);
  if (!o) return null;
  const issue = {
    id: str(o.id) || null,
    summary: str(o.summary) || '',
    status: ['open', 'in_progress'].includes(o.status) ? o.status : 'open',
  };
  if (['customer_confirmed', 'owner'].includes(o.resolved_by)) issue.resolved_by = o.resolved_by;
  if (o.resolved_at != null) issue.resolved_at = str(o.resolved_at);
  if (o.first_seen_at != null) issue.first_seen_at = str(o.first_seen_at);
  return issue;
}

// Entity type is GENERIC (spec §3): the platform must not be locked to a closed
// vertical whitelist. Any non-empty, slug-safe type string is accepted (product,
// service, subscription, plan, variant, order, payment_method, issue, topic, …).
// It carries lifecycle metadata so the newest/most-relevant entity can be chosen.
function entityType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return s ? s.slice(0, 40) : null;
}
function validateEntity(x) {
  const o = plainObject(x);
  if (!o) return null;
  const type = entityType(o.type);
  if (!type) return null;
  const e = { type, ref: shortStr(o.ref) || null, label: shortStr(o.label) || null };
  // V2 lifecycle metadata (optional; back-compat readers ignore extra keys).
  e.status = shortStr(o.status, 40) || null;
  e.confidence = confidenceOf(o.confidence);
  e.first_seen = shortStr(o.first_seen, 40) || null;
  e.last_seen = shortStr(o.last_seen, 40) || null;
  return e;
}

// The single most-relevant entity: the one with the greatest last_seen marker
// (lexicographically comparable — sequence numbers or ISO timestamps both work),
// falling back to the last entry when no markers exist. Keeps V1's `active_entity`
// meaningful for any code that reads it, derived from the V2 list.
function deriveActiveEntity(entities) {
  const list = arr(entities).filter(Boolean);
  if (!list.length) return null;
  let best = list[0];
  for (const e of list) {
    if (e.last_seen != null && (best.last_seen == null || String(e.last_seen) > String(best.last_seen))) best = e;
  }
  return best;
}

function validatePendingExpectation(x) {
  const o = plainObject(x);
  if (!o) return null;
  const type = shortStr(o.type, 60);
  if (!type) return null; // an expectation without a type is meaningless
  return {
    type,
    purpose: shortStr(o.purpose, 160) || null,
    related_entity: shortStr(o.related_entity, 120) || null,
  };
}

// Memory sources are AUTHORITY-tagged (spec §9): only these are trusted origins.
// A model that tries to launder its own claim ("assistant"/anything else) into a
// memory is normalised to `unknown` (or `previous_bot_statement` when it clearly
// self-labels), and such a memory is NEVER promoted to a verified known_fact.
const TRUSTED_MEMORY_SOURCES = new Set(['customer', 'merchant', 'system', 'tool']);
function memorySource(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (TRUSTED_MEMORY_SOURCES.has(s)) return s;
  if (s === 'previous_bot_statement' || s === 'bot' || s === 'assistant') return 'previous_bot_statement';
  return 'unknown';
}
function validateMemory(x) {
  const o = plainObject(x);
  if (!o) return null;
  const summary = shortStr(o.summary, 240);
  if (!summary) return null; // no summary → not a memory
  return {
    summary,
    kind: shortStr(o.kind, 40) || null,
    related_entities: arr(o.related_entities).map((r) => shortStr(r, 120)).filter(Boolean).slice(0, 6),
    source: memorySource(o.source),
    confidence: confidenceOf(o.confidence),
    message_ref: shortStr(o.message_ref, 60) || null,
    last_updated: shortStr(o.last_updated, 40) || null,
  };
}

// Deterministic value score for capping: trusted sources and higher confidence
// are worth more; `previous_bot_statement`/`unknown` are cheapest. Used ONLY to
// decide which memories survive the cap — never to fabricate authority.
function memoryValue(m) {
  const srcScore = TRUSTED_MEMORY_SOURCES.has(m.source) ? 2 : (m.source === 'previous_bot_statement' ? 1 : 0);
  const confScore = m.confidence === 'high' ? 2 : m.confidence === 'medium' ? 1 : 0;
  return srcScore * 3 + confScore;
}
function capMemories(memories) {
  const list = arr(memories).map(validateMemory).filter(Boolean);
  if (list.length <= MAX_SALIENT_MEMORIES) return list;
  // Stable sort by value desc (Array.prototype.sort is stable in Node) so ties
  // keep insertion order, then keep the top N. Deterministic — no clock, no RNG.
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => memoryValue(b.m) - memoryValue(a.m) || a.i - b.i)
    .slice(0, MAX_SALIENT_MEMORIES)
    .sort((a, b) => a.i - b.i) // restore original order among survivors
    .map((x) => x.m);
}

function validateReference(x) {
  const o = plainObject(x);
  if (!o) return null;
  const text = shortStr(o.text, 120);
  if (!text) return null; // a reference must name the surface form it resolves
  return {
    text,
    entity: shortStr(o.entity, 160) || null,
    confidence: confidenceOf(o.confidence),
  };
}
function validateLastTurnUnderstanding(x) {
  const o = plainObject(x) || {};
  return {
    intent: shortStr(o.intent, 80) || null,
    resolved_references: arr(o.resolved_references).map(validateReference).filter(Boolean).slice(0, MAX_RESOLVED_REFERENCES),
    topic_transition: shortStr(o.topic_transition, 40) || null,
    customer_correction: o.customer_correction === true,
  };
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
  const active_entities = arr(o.active_entities).map(validateEntity).filter(Boolean).slice(0, MAX_ACTIVE_ENTITIES);
  // active_entity (V1) is either the explicitly-set entity or, for a V2-only
  // state, DERIVED from the newest active entity — so any legacy reader still
  // resolves a single active entity.
  const explicitActive = validateEntity(o.active_entity);
  const active_entity = explicitActive || deriveActiveEntity(active_entities);
  return {
    schema_version: 2,
    // ── V1 slots ──
    open_issues: arr(o.open_issues).map(validateIssue).filter(Boolean),
    resolved_issues: arr(o.resolved_issues).map(validateIssue).filter(Boolean),
    active_topic: str(o.active_topic),
    active_entity,
    known_facts: validateFacts(o.known_facts),
    customer_goal: str(o.customer_goal),
    actions_attempted: arr(o.actions_attempted).map(validateAction).filter(Boolean),
    last_reply_intent: str(o.last_reply_intent),
    // ── V2 slots ──
    active_entities,
    recent_topics: arr(o.recent_topics).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 80)).slice(0, MAX_RECENT_TOPICS),
    pending_expectation: validatePendingExpectation(o.pending_expectation),
    salient_memories: capMemories(o.salient_memories),
    last_turn_understanding: validateLastTurnUnderstanding(o.last_turn_understanding),
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
  '- You do NOT decide handoff/escalation status and you do NOT mark any systemic action as done. Do NOT set resolved_by="owner" and do NOT set actions_attempted.confirmed_by="system" — those are stamped by the platform (النظام), not by you.',
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

/**
 * The LLM owns only the SEMANTIC state. Systemic truth (handoff status, real
 * tool-execution outcomes) is stamped by the platform from authoritative
 * records — never by the model. This strips any LLM attempt to claim it, and
 * attaches the system-owned facts under `state.system`.
 */
function reconcileSystemState(llmState, systemFacts = {}) {
  const s = validateState(llmState);
  s.resolved_issues = s.resolved_issues.filter((i) => i.resolved_by !== 'owner');
  s.actions_attempted = s.actions_attempted.map((a) =>
    a.confirmed_by === 'system' ? { ...a, confirmed_by: null } : a);
  s.system = { escalationPending: systemFacts.escalationPending === true };
  return s;
}

/**
 * Render the state as an internal system-prompt block. Fail-soft: emits nothing
 * unless `canInject` is true (the caller only sets it when the stored state is
 * current and extraction succeeded — a stale/failed state is never shown as
 * truth). Emits nothing when there is nothing worth saying.
 */
function buildConversationStateBlock(state, { canInject } = {}) {
  if (!canInject || !state) return '';
  const resolved = Array.isArray(state.resolved_issues) ? state.resolved_issues.filter((i) => i && i.summary) : [];
  const open = Array.isArray(state.open_issues) ? state.open_issues.filter((i) => i && i.summary) : [];
  const facts = state.known_facts && typeof state.known_facts === 'object' && !Array.isArray(state.known_facts)
    ? Object.entries(state.known_facts) : [];
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

/**
 * Meaning-based duplicate check: a drafted reply repeats a recent reply's
 * intent AND no new customer turn arrived in between (i.e. the bot would be
 * saying the same thing again unprompted). A new customer turn legitimises
 * repeating an intent (they asked again), so it is never a duplicate then.
 */
function isSemanticDuplicate({ candidateIntent, recentReplyIntents = [], hasNewCustomerTurnSinceLastAssistant = false } = {}) {
  const c = String(candidateIntent || '').trim();
  if (!c) return false;
  if (hasNewCustomerTurnSinceLastAssistant) return false;
  return recentReplyIntents.some((i) => String(i || '').trim() === c);
}

/**
 * Atomic send-time stale claim. A single conditional UPDATE transitions the
 * reply row queued_for_send → sending ONLY IF no customer inbound with a HIGHER
 * sequence than the batch this reply answered exists — closing the
 * read-then-send race. 0 rows affected ⇒ a newer message arrived ⇒ the reply is
 * stale. Comparison is a pure integer sequence sourced entirely from the
 * database (conversations.inbound_seq → messages.inbound_seq), so there is no
 * app-clock-vs-DB-clock skew. Explicitly tenant-scoped by user_id in both the
 * outer row and the NOT EXISTS subquery. 'sending' is claimable too so a BullMQ
 * retry of the SAME reply can re-claim; only a genuinely newer inbound makes it
 * stale. Rows predating the inbound_seq migration are NULL and never match `>`.
 */
function buildStaleClaimQuery({ replyMessageId, userId, conversationId, generatedAgainstSeq }) {
  const sql = `UPDATE messages
   SET status = 'sending'
 WHERE id = $1
   AND user_id = $2
   AND conversation_id = $3
   AND status IN ('queued_for_send', 'sending')
   AND NOT EXISTS (
     SELECT 1 FROM messages m2
      WHERE m2.user_id = $2
        AND m2.conversation_id = $3
        AND m2.direction = 'inbound'
        AND m2.inbound_seq > $4
   )
 RETURNING id`;
  return { sql, params: [replyMessageId, userId, conversationId, generatedAgainstSeq] };
}

// ── Deterministic resolved-issue reopen guard ─────────────────────────────
// A code-level check (beyond prompt injection) that a drafted reply is not
// re-suggesting steps for an issue the customer already confirmed resolved.
// Language-agnostic token overlap — no vertical vocabulary, no LLM.

const REOPEN_STOPWORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ان', 'أن', 'انا', 'أنا',
  'هو', 'هي', 'ما', 'لا', 'و', 'او', 'أو', 'يا', 'قد', 'كل', 'اي', 'أي',
  'the', 'a', 'an', 'to', 'of', 'is', 'it', 'for', 'and', 'or', 'you', 'your',
]);

function reopenTokens(s) {
  return String(s == null ? '' : s)
    .replace(/[ً-ْٰ]/g, '')       // Arabic diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2 && !REOPEN_STOPWORDS.has(t));
}

/**
 * Returns { reopened, issue }. A reply "reopens" a resolved issue when it echoes
 * most of that issue's content tokens (≥ threshold) WHILE the customer's latest
 * message did NOT re-raise it (< 0.5 overlap) — i.e. the bot is volunteering
 * steps for something already confirmed done. If the customer brought it up
 * again, repeating is legitimate and NOT flagged.
 */
function detectResolvedReopen(replyText, resolvedIssues = [], customerText = '', { threshold = 0.6 } = {}) {
  const list = Array.isArray(resolvedIssues) ? resolvedIssues : [];
  if (!list.length) return { reopened: false, issue: null };
  const replySet = new Set(reopenTokens(replyText));
  const customerSet = new Set(reopenTokens(customerText));
  for (const issue of list) {
    const summary = issue && issue.summary;
    if (!summary) continue;
    const issueTokens = reopenTokens(summary);
    if (!issueTokens.length) continue;
    const inReply = issueTokens.filter(t => replySet.has(t)).length / issueTokens.length;
    const inCustomer = issueTokens.filter(t => customerSet.has(t)).length / issueTokens.length;
    if (inReply >= threshold && inCustomer < 0.5) {
      return { reopened: true, issue: summary };
    }
  }
  return { reopened: false, issue: null };
}

module.exports = {
  EMPTY_STATE,
  validateState,
  parseExtractionResponse,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionRequest,
  reconcileSystemState,
  buildConversationStateBlock,
  isSemanticDuplicate,
  buildStaleClaimQuery,
  detectResolvedReopen,
};
