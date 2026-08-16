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
  'You maintain a STRUCTURED STATE of an ongoing customer-service conversation for an online store, so a colleague can understand the customer\'s WHOLE story — not just the latest message.',
  'The store may sell anything (physical goods, bookings, software, subscriptions, services). Stay fully generic — never assume a product, brand, vertical, or payment provider.',
  'You receive the PRIOR state (JSON), the LAST bot reply, and the NEW messages since the state was computed. Output the UPDATED state as STRICT JSON only — no prose, no code fences. Do everything in THIS one response.',
  '',
  'Schema keys:',
  '- open_issues[], resolved_issues[] : each {id, summary, status}. resolved_by="customer_confirmed" when the customer confirms.',
  '- active_topic : the topic being discussed right now (string).',
  '- recent_topics[] : short list of earlier topics still worth remembering (so the customer can return to one).',
  '- active_entities[] : every product/service/subscription/plan/variant/order/payment_method/issue/topic that has come up. Each {type, ref, label, status, confidence:"high|medium|low", first_seen, last_seen}. Set last_seen to the LATEST turn marker where it appeared so the newest is identifiable. Keep MANY entities (the customer may switch and return), not just one.',
  '- active_entity : the single most-relevant entity right now (usually the newest active_entities item).',
  '- known_facts{} : ONLY facts the CUSTOMER stated explicitly, or facts from merchant/system/tool sources (e.g. a phone number they gave, a package they chose). Flat map of short strings.',
  '- customer_goal : what the customer is ultimately trying to achieve.',
  '- actions_attempted[] : {action, outcome:"worked|failed|unknown", confirmed_by:"customer"|null} — steps already tried, so they are not blindly repeated.',
  '- pending_expectation : if the BOT asked the customer for something and is waiting (a phone number, an order id, an email, a name, a package choice, a payment method, a yes/no, a photo), set {type, purpose, related_entity}. Clear it (null) once the customer supplies it.',
  '- salient_memories[] : durable things worth remembering. Each {summary, kind, related_entities[], source:"customer|merchant|system|tool|previous_bot_statement", confidence, message_ref, last_updated}. Extract only what matters (a choice, a correction, an ongoing problem, a fact the customer gave, a step tried and its result, an unresolved question, a topic that may come back). Do NOT copy the whole transcript.',
  '- last_turn_understanding : {intent, resolved_references[], topic_transition:"continue|switch|return", customer_correction:true|false} for the LATEST customer message.',
  '',
  'REFERENCE RESOLUTION (important): customers rarely repeat names. When the latest message uses a short reference or pronoun (الاشتراك، المنتج، الطلب، المشكلة، هو، هي، هذا، هذي، ذاك، الثاني، الأول، اللي قلت لك عنه، نفس المشكلة، نفس الاشتراك), resolve it to the concrete entity from context and record it in last_turn_understanding.resolved_references as {text, entity, confidence}. Resolve automatically when ONE strong candidate fits; only leave it low-confidence when two candidates are genuinely equal. Precedence when choosing: (1) the customer\'s explicit latest statement, (2) a customer correction/change, (3) a compatible current entity, (4) the current topic, (5) a recent relevant entity, (6) an older salient memory. Merely having two old entities in history is NOT ambiguity.',
  '',
  'CORRECTIONS (§6): if the customer changes their mind ("لا خلاص السنوي", "لا Y أفضل", "لا المشكلة بالتفعيل مو الدخول"), the NEW choice wins: update active_entity/active_topic/open_issues accordingly and set last_turn_understanding.customer_correction=true. Keep the old value in history (recent_topics/active_entities/salient_memories) but it is no longer the active context.',
  '',
  'Rules:',
  '- When the customer confirms a step/issue is done (any language: "تم", "دخلت", "وصل", "اشتغل", "ضبط", "جاني الكود", "done", "worked"), MOVE that issue from open_issues to resolved_issues with resolved_by="customer_confirmed". Never keep a customer-confirmed issue open, and do not reopen it unless the customer says it came back.',
  '- When a NEW, distinct problem appears, ADD it to open_issues without dropping other still-open issues.',
  '- HALLUCINATION SAFETY (§9): known_facts must NEVER contain something only the BOT claimed. If the bot said something not yet confirmed by the customer/system, record it as a salient_memory with source="previous_bot_statement" (or as pending_expectation), NEVER as a known_fact.',
  '- You do NOT decide handoff/escalation status and you do NOT mark any systemic action as done. Do NOT set resolved_by="owner" and do NOT set actions_attempted.confirmed_by="system" — those are stamped by the platform (النظام/system), not by you.',
  '- Keep every summary and label short. Prefer FEW high-value memories over many. Output valid JSON matching the schema and nothing else.',
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
    max_tokens: 700,
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

// Select the salient memories most relevant to the latest customer message
// (spec §13: RETRIEVE relevant context, don't dump all). Deterministic scoring:
// token overlap with the latest message + a small value bonus; recency breaks
// ties. With no latest message, fall back to the highest-value memories. No LLM,
// no vector DB — just state + token relevance.
function selectRelevantMemories(memories, latestUserText = '', limit = 6) {
  const list = arr(memories).filter((m) => m && m.summary);
  if (list.length <= 1) return list.slice(0, limit);
  const q = new Set(reopenTokens(latestUserText));
  const scored = list.map((m, i) => {
    const toks = new Set(reopenTokens(`${m.summary} ${(m.related_entities || []).join(' ')}`));
    let overlap = 0;
    for (const t of toks) if (q.has(t)) overlap += 1;
    return { m, i, score: overlap * 10 + memoryValue(m) };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.m);
}

/**
 * Render the state as the internal CURRENT CUSTOMER CONTEXT block (spec §14).
 * Fail-soft: emits nothing unless `canInject` is true (the caller sets it only
 * when the stored state is current and extraction succeeded — a stale/failed
 * state is never shown as truth). Sections are assembled in PRIORITY order and
 * kept within a character budget (§19) so context never balloons; the behavioural
 * footer is always preserved. Backward compatible with V1-shaped states.
 */
function buildConversationStateBlock(state, { canInject, latestUserText = '', maxChars } = {}) {
  if (!canInject || !state) return '';
  const budget = Math.max(400, Number(maxChars || process.env.CONVERSATION_STATE_BLOCK_MAX_CHARS || 2200));

  const ltu = state.last_turn_understanding || {};
  const refs = arr(ltu.resolved_references).filter((r) => r && r.text && r.entity);
  const entities = arr(state.active_entities).filter((e) => e && (e.label || e.ref));
  const open = arr(state.open_issues).filter((i) => i && i.summary);
  const resolved = arr(state.resolved_issues).filter((i) => i && i.summary);
  const facts = (state.known_facts && typeof state.known_facts === 'object' && !Array.isArray(state.known_facts))
    ? Object.entries(state.known_facts) : [];
  const actions = arr(state.actions_attempted).filter((a) => a && a.action);
  const memories = arr(state.salient_memories).filter((m) => m && m.summary);
  // Relevant-context memories (customer/merchant/system/tool/unknown) — shown as
  // context, NOT as confirmed facts. Only a self-labelled bot claim is quarantined
  // into the explicitly-unverified section (§9).
  const relevantMem = memories.filter((m) => m.source !== 'previous_bot_statement');
  const unverifiedMem = memories.filter((m) => m.source === 'previous_bot_statement');
  const pe = state.pending_expectation;

  // Priority-ordered sections (§19). Each is an array of lines; empty ones drop.
  const sections = [];
  if (refs.length) {
    const s = ['🔎 مراجع محلولة في رسالة العميل الأخيرة (اعتمد المعنى المقصود مباشرة):'];
    for (const r of refs) s.push(`- "${r.text}" ← ${r.entity}${r.confidence ? ` (${r.confidence})` : ''}`);
    sections.push(s);
  }
  if (state.customer_goal) sections.push([`🎯 هدف العميل: ${state.customer_goal}`]);
  {
    const s = [];
    if (state.active_topic) s.push(`🧵 الموضوع النشط الآن: ${state.active_topic}`);
    if (entities.length) {
      s.push('📦 كيانات نشطة في المحادثة (الأحدث أهم):');
      for (const e of entities.slice(0, 8)) s.push(`- ${e.label || e.ref}${e.type ? ` [${e.type}]` : ''}${e.status ? ` — ${e.status}` : ''}`);
    }
    if (s.length) sections.push(s);
  }
  if (ltu.intent) sections.push([`🧭 نية الرسالة الأخيرة: ${ltu.intent}`]);
  if (open.length) {
    const s = ['🟡 أمور ما زالت مفتوحة — عالجها:'];
    for (const i of open) s.push(`- ${i.summary}`);
    sections.push(s);
  }
  if (resolved.length) {
    const s = ['✅ أمور تأكّد حلّها في هذه المحادثة — لا تقترحها ولا تُعِد خطواتها إلا إذا أبلغ العميل بعودتها:'];
    for (const i of resolved) s.push(`- ${i.summary}`);
    sections.push(s);
  }
  if (pe && pe.type) {
    sections.push([`⏳ بانتظار رد العميل: طلبتَ منه (${pe.type}${pe.purpose ? ` — ${pe.purpose}` : ''}). أي رد قصير مناسب فسّره كإجابة على هذا الطلب، لا كرسالة مبهمة.`]);
  }
  if (facts.length) {
    const s = ['📌 معلومات مؤكدة عن العميل (لا تطلبها من جديد):'];
    for (const [k, v] of facts) s.push(`- ${k}: ${v}`);
    sections.push(s);
  }
  if (ltu.customer_correction) sections.push(['✏️ العميل صحّح/غيّر اختياره في رسالته الأخيرة — اعتمد الأحدث، وتجاهل الاختيار القديم كسياق نشط.']);
  if (actions.length) {
    const s = ['🔁 خطوات سبق تجربتها (لا تُكررها بلا داعٍ):'];
    for (const a of actions) s.push(`- ${a.action}${a.outcome && a.outcome !== 'unknown' ? ` (${a.outcome})` : ''}`);
    sections.push(s);
  }
  const relTrusted = selectRelevantMemories(relevantMem, latestUserText, 6);
  if (relTrusted.length) {
    const s = ['🗂️ ذاكرة ذات صلة:'];
    for (const m of relTrusted) s.push(`- ${m.summary}`);
    sections.push(s);
  }
  const relUnverified = selectRelevantMemories(unverifiedMem, latestUserText, 3);
  if (relUnverified.length) {
    const s = ['⚠️ سبق أن قاله البوت (غير مؤكد — لا تعتمده كحقيقة إلا إذا أكّده العميل أو النظام):'];
    for (const m of relUnverified) s.push(`- ${m.summary}`);
    sections.push(s);
  }

  if (!sections.length) return '';

  const header = '\n\n🧭 حالة المحادثة (سياق داخلي — لا تذكره للعميل):';
  const footer = [
    '',
    'تعليمات استخدام السياق:',
    '- اعتبر المراجع المحلولة عالية الثقة هي المعنى المقصود، ولا تسأل عن معلومة معروفة أصلاً هنا.',
    '- لا تُعِد خطوة تأكّد حلّها ولا خطوة سبق تجربتها إلا إذا استدعى السياق إعادتها.',
    '- اسأل سؤال توضيح واحد فقط عند غموض حقيقي (مرشحان متساويان)؛ ومجرد وجود الغموض ليس سبباً للتصعيد.',
    '- لا تدّعِ أن إجراءً تم إلا إذا أكّده النظام أو أداة فعلية.',
  ].join('\n');

  // Assemble within budget (§19): always keep the footer; add sections top-down
  // until the budget is exhausted. Top-priority sections are added first, so
  // low-value memory sections are the first to be dropped when space runs out.
  const reserve = footer.length + header.length + 4;
  let used = reserve;
  const kept = [];
  for (const s of sections) {
    const text = s.join('\n');
    if (used + text.length + 1 > budget && kept.length) break;
    kept.push(text);
    used += text.length + 1;
  }
  return `${header}\n${kept.join('\n')}${footer}`;
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
