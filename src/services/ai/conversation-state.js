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
};
