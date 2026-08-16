'use strict';

/**
 * Context Engine V2 — long conversation REPLAY (spec §22).
 *
 * Drives a realistic 30-turn customer-service conversation through the REAL reply
 * path: history → extraction (extractConversationState) → resolution
 * (deriveResolvedPricingContext) → computePrice (resolvePriceComputation) → the
 * REAL system prompt (AIClient.buildSystemPrompt = the model input). It prints the
 * salient state fields per turn and asserts the acceptance invariants (§28).
 *
 * No DB, no Redis, no secrets. This script proves the CONSUMPTION PLUMBING
 * deterministically: the EXTRACTION step is a stand-in (a fixture-merger plays the
 * role of the LLM, clearly labelled), while resolution, computePrice and the
 * system prompt are the REAL code. For a fully LIVE run (real extraction model +
 * real main reply model + validators/escalation → final customer text) use
 * scripts/context-engine-v2-live.js with a staging provider key.
 *
 * Run: node scripts/context-engine-v2-replay.js
 */

const AIClient = require('../lib/ai-client');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');
const { deriveResolvedPricingContext, resolvePriceComputation } = require('../src/services/ai/deterministic-calc');

process.env.CONVERSATION_STATE_ENABLED = 'true';

// ── Tenant fixtures (generic — no real store/brand/company) ────────────────
const config = {
  storeName: 'متجر تجريبي',
  products: [
    { name: 'اشتراك أدوبي', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] },
    { name: 'قالب كانفا', price: 50 },
  ],
  // Generic installment fee rule (trigger is a payment CONDITION, not a company).
  pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }],
};

// ── Deterministic fixture "extractor" (stand-in for the LLM offline) ────────
// Applies a per-turn understanding hint onto the prior state. Generic merge, no
// vertical logic — it only demonstrates what a competent extractor would emit.
function applyExtraction(prior, hint, turnIdx) {
  const s = JSON.parse(JSON.stringify(prior || {}));
  s.schema_version = 2;
  s.active_entities = s.active_entities || [];
  s.open_issues = s.open_issues || [];
  s.resolved_issues = s.resolved_issues || [];
  s.recent_topics = s.recent_topics || [];
  s.salient_memories = s.salient_memories || [];
  const seen = String(turnIdx);

  const upsert = (e) => {
    const i = s.active_entities.findIndex((x) => x.type === e.type && x.ref === e.ref);
    const base = i >= 0 ? s.active_entities[i] : { first_seen: seen };
    const merged = { ...base, ...e, last_seen: seen };
    if (i >= 0) s.active_entities[i] = merged; else s.active_entities.push(merged);
  };
  (hint.addEntities || []).forEach(upsert);

  if (hint.topic) {
    if (s.active_topic && s.active_topic !== hint.topic && !s.recent_topics.includes(s.active_topic)) s.recent_topics.unshift(s.active_topic);
    s.active_topic = hint.topic;
  }
  if (hint.goal) s.customer_goal = hint.goal;
  if (hint.openIssue) {
    if (!s.open_issues.find((i) => i.id === hint.openIssue.id)) s.open_issues.push({ ...hint.openIssue, status: 'open' });
    s.resolved_issues = s.resolved_issues.filter((i) => i.id !== hint.openIssue.id);
  }
  if (hint.resolveIssue) {
    const idx = s.open_issues.findIndex((i) => i.id === hint.resolveIssue);
    if (idx >= 0) { const [it] = s.open_issues.splice(idx, 1); s.resolved_issues.push({ ...it, resolved_by: 'customer_confirmed' }); }
  }
  if (hint.action) s.actions_attempted = [...(s.actions_attempted || []), hint.action];
  if (hint.pending !== undefined) s.pending_expectation = hint.pending; // object or null
  if (hint.memory) s.salient_memories.push(hint.memory);
  s.last_turn_understanding = {
    intent: hint.intent || null,
    resolved_references: hint.refs || [],
    topic_transition: hint.transition || 'continue',
    customer_correction: hint.correction === true,
  };
  return s;
}
function fixtureAi(rawState) {
  return { raw: async () => ({ choices: [{ message: { content: JSON.stringify(rawState) } }] }) };
}

// ── 30-turn conversation (C = customer, B = bot). Customer turns carry `x` = the
// understanding a competent extractor should produce. ──────────────────────
const ADOBE = { type: 'subscription', ref: 'adobe', label: 'اشتراك أدوبي' };
const CANVA = { type: 'product', ref: 'canva', label: 'قالب كانفا' };
const script = [
  { s: 'C', t: 'السلام عليكم، عندكم اشتراك أدوبي؟', x: { topic: 'اشتراك أدوبي', goal: 'شراء اشتراك أدوبي', addEntities: [ADOBE], intent: 'ask_availability' } },
  { s: 'B', t: 'وعليكم السلام، نعم متوفر شهري وسنوي.' },
  { s: 'C', t: 'كم الشهري؟', x: { addEntities: [{ type: 'variant', ref: 'monthly', label: 'شهري' }], intent: 'ask_price', refs: [{ text: 'الشهري', entity: 'شهري', confidence: 'high' }] } },
  { s: 'B', t: 'الشهري بـ20 ريال.' },
  { s: 'C', t: 'طيب والسنوي؟', x: { addEntities: [{ type: 'variant', ref: 'yearly', label: 'سنوي' }], intent: 'ask_price', refs: [{ text: 'السنوي', entity: 'سنوي', confidence: 'high' }], correction: true } },
  { s: 'B', t: 'السنوي بـ200 ريال.' },
  { s: 'C', t: 'عندكم قوالب كانفا؟', x: { topic: 'قالب كانفا', addEntities: [CANVA], intent: 'ask_availability', transition: 'switch' } },
  { s: 'B', t: 'نعم، قالب كانفا بـ50.' },
  { s: 'C', t: 'كم سعره؟', x: { intent: 'ask_price', refs: [{ text: 'سعره', entity: 'قالب كانفا', confidence: 'high' }] } },
  { s: 'B', t: 'بـ50 ريال.' },
  { s: 'C', t: 'طيب رجعنا للأدوبي، أبي السنوي', x: { topic: 'اشتراك أدوبي', addEntities: [ADOBE, { type: 'variant', ref: 'yearly', label: 'سنوي' }], intent: 'select_variant', transition: 'return', refs: [{ text: 'الأدوبي', entity: 'اشتراك أدوبي', confidence: 'high' }] } },
  { s: 'B', t: 'تمام، السنوي بـ200.' },
  { s: 'C', t: 'عندي مشكلة ما أقدر أفعّل الحساب', x: { topic: 'تفعيل الحساب', openIssue: { id: 'activation', summary: 'تفعيل الحساب' }, intent: 'report_problem' } },
  { s: 'B', t: 'جرب تسجّل خروج ودخول.' },
  { s: 'C', t: 'سويت وما زبط', x: { action: { action: 'تسجيل خروج ودخول', outcome: 'failed', confirmed_by: 'customer' }, intent: 'report_problem' } },
  { s: 'B', t: 'طيب أرسل لي رقم الطلب عشان أتحقق.' }, // creates a pending expectation (order_id)
  { s: 'C', t: '10234', x: { pending: null, memory: { summary: 'رقم الطلب 10234', source: 'customer', confidence: 'high' }, intent: 'provide_info' } }, // short reply answers it
  { s: 'B', t: 'تمام، نتحقق.' },
  { s: 'C', t: 'تمام تفعّل الحين', x: { resolveIssue: 'activation', intent: 'confirm_resolved' } },
  { s: 'B', t: 'ممتاز، صار تمام.' },
  { s: 'C', t: 'بخصوص نفس الاشتراك، مضمون؟', x: { topic: 'اشتراك أدوبي', intent: 'ask_warranty', refs: [{ text: 'نفس الاشتراك', entity: 'اشتراك أدوبي', confidence: 'high' }] } },
  { s: 'B', t: 'نعم مضمون.' },
  { s: 'C', t: 'كيف أدفع؟', x: { topic: 'الدفع', intent: 'ask_payment' } },
  { s: 'B', t: 'تقدر تدفع عادي أو تقسيط.' },
  { s: 'C', t: 'تقسيط', x: { addEntities: [{ type: 'payment_method', ref: 'installment', label: 'تقسيط' }], intent: 'payment_method_selection', pending: null } }, // bare short reply = payment selection
  { s: 'B', t: 'تمام، بالتقسيط.' },
  { s: 'C', t: 'كم يطلع؟', x: { intent: 'ask_price', refs: [{ text: 'يطلع', entity: 'اشتراك أدوبي سنوي', confidence: 'high' }] } }, // → 200 +10% = 220
  { s: 'B', t: 'يطلع 220.' },
  { s: 'C', t: 'طيب نفس المشكلة رجعت', x: { openIssue: { id: 'activation', summary: 'تفعيل الحساب' }, intent: 'report_problem', refs: [{ text: 'نفس المشكلة', entity: 'تفعيل الحساب', confidence: 'high' }] } }, // explicit reopen
];

const ai = new AIClient(config, { info() {}, warn() {}, error() {} });
let state = {};
const history = [];
const turnLog = [];
const metrics = { turns: 0, wrong_references: 0, unnecessary_clarifications: 0, false_escalations: 0, repeated_resolved_steps: 0 };
let maxBlockSize = 0;

function short(v) { return v == null ? '—' : String(v); }

(async () => {
  for (let i = 0; i < script.length; i++) {
    const turn = script[i];
    if (turn.s === 'B') { history.push({ role: 'assistant', content: turn.t });
      // The bot asking for the order id creates a pending expectation the NEXT
      // customer turn should answer (spec §7).
      if (/رقم الطلب/.test(turn.t)) state.pending_expectation = { type: 'order_id', purpose: 'التحقق من التفعيل' };
      continue;
    }
    history.push({ role: 'user', content: turn.t });
    metrics.turns++;

    const rawNext = applyExtraction(state, turn.x || {}, i);
    const extracted = await extractConversationState({
      userId: 'tenant-demo', conversationId: 'conv-demo',
      previousState: state, newTurns: [{ role: 'user', content: turn.t }],
      lastBotReply: [...history].reverse().find((m) => m.role === 'assistant')?.content || '',
      aiClient: fixtureAi(rawNext), systemFacts: { escalationPending: false },
    });
    state = extracted.state;

    const rc = deriveResolvedPricingContext(state);
    const priceRes = resolvePriceComputation({ history, latestUserText: turn.t, config, resolvedContext: rc });
    const sys = ai.buildSystemPrompt(history, { conversationState: state, conversationStateCanInject: extracted.extraction_ok, latestUserText: turn.t });
    maxBlockSize = Math.max(maxBlockSize, sys.length);

    let decision = 'answer normally';
    if (priceRes.status === 'computed') decision = `quote total = ${priceRes.computation.total}`;
    else if (String(priceRes.status).startsWith('ambiguous')) decision = 'ask ONE clarification';
    else if (state.pending_expectation) decision = `await ${state.pending_expectation.type}`;

    // ── metrics ──
    for (const r of (state.last_turn_understanding.resolved_references || [])) {
      const hit = (state.active_entities || []).some((e) => e.label && r.entity && (r.entity.includes(e.label) || e.label.includes(r.entity)))
        || (state.resolved_issues || []).concat(state.open_issues || []).some((is) => is.summary && r.entity && r.entity.includes(is.summary));
      if (!hit) metrics.wrong_references++;
    }
    if (String(priceRes.status).startsWith('ambiguous') && rc.activeProduct && priceRes.status === 'ambiguous_product') metrics.unnecessary_clarifications++;
    if (/\[تحويل:/.test(sys)) metrics.false_escalations++;
    for (const ri of (state.resolved_issues || [])) {
      if ((state.open_issues || []).some((oi) => oi.summary === ri.summary)) metrics.repeated_resolved_steps++;
    }

    turnLog.push({
      i, text: turn.t, price: priceRes,
      refs: (state.last_turn_understanding.resolved_references || []).map((r) => r.entity),
      open: (state.open_issues || []).map((x) => x.summary),
      hasAdobe: (state.active_entities || []).some((e) => e.ref === 'adobe'),
    });

    console.log(`\n─ turn ${i} · ${turn.t}`);
    console.log(`  goal=${short(state.customer_goal)} | topic=${short(state.active_topic)} | intent=${short(state.last_turn_understanding.intent)} | transition=${short(state.last_turn_understanding.topic_transition)}${state.last_turn_understanding.customer_correction ? ' | CORRECTION' : ''}`);
    console.log(`  active_entities=[${(state.active_entities || []).map((e) => `${e.type}:${e.label}`).join(', ')}]`);
    console.log(`  resolved_refs=[${(state.last_turn_understanding.resolved_references || []).map((r) => `"${r.text}"→${r.entity}`).join(', ') || '—'}]`);
    console.log(`  open=[${(state.open_issues || []).map((x) => x.summary).join(', ') || '—'}] resolved=[${(state.resolved_issues || []).map((x) => x.summary).join(', ') || '—'}]`);
    console.log(`  pending=${state.pending_expectation ? state.pending_expectation.type : '—'} | selected_product=${short(rc.activeProduct)} | selected_variant=${short(rc.activeVariant)} | selected_payment=${short(rc.activePaymentMethod)}`);
    console.log(`  price_status=${priceRes.status}${priceRes.computation ? ` total=${priceRes.computation.total}` : ''} | DECISION: ${decision}`);
  }

  console.log('\n════════ LONG REPLAY SUMMARY ════════');
  console.log(`turns: ${metrics.turns}`);
  console.log(`wrong references: ${metrics.wrong_references}`);
  console.log(`unnecessary clarifications: ${metrics.unnecessary_clarifications}`);
  console.log(`false escalations: ${metrics.false_escalations}`);
  console.log(`repeated resolved steps: ${metrics.repeated_resolved_steps}`);
  console.log(`max system-prompt size (chars): ${maxBlockSize}`);

  // ── acceptance assertions (§28) ──
  const assert = require('node:assert/strict');
  const fail = [];
  const check = (name, fn) => { try { fn(); } catch (e) { fail.push(`${name}: ${e.message}`); } };
  const at = (txt) => turnLog.find((r) => r.text === txt);
  check('short reference "نفس الاشتراك" (20+ turns later) resolves to أدوبي', () => {
    const r = at('بخصوص نفس الاشتراك، مضمون؟');
    assert.ok(r && r.refs.some((e) => e && e.includes('أدوبي')));
  });
  check('short reference "الأول"/return recovers أدوبي subscription throughout', () => assert.ok(turnLog.every((r) => r.hasAdobe)));
  check('"كم يطلع؟" after تقسيط computes 220 (200 + 10%)', () => {
    const r = at('كم يطلع؟');
    assert.ok(r && r.price.status === 'computed' && r.price.computation.total === 220);
  });
  check('"كم الشهري؟" computes 20 and "طيب والسنوي؟"→"كم سعره؟" flow prices correctly', () => {
    const m = at('كم الشهري؟');
    assert.ok(m && m.price.status === 'computed' && m.price.computation.total === 20);
  });
  check('no wrong references', () => assert.equal(metrics.wrong_references, 0));
  check('no unnecessary clarifications', () => assert.equal(metrics.unnecessary_clarifications, 0));
  check('no false escalations', () => assert.equal(metrics.false_escalations, 0));
  check('reopened issue "نفس المشكلة رجعت" is open again (explicit)', () => {
    const r = at('طيب نفس المشكلة رجعت');
    assert.ok(r && r.open.includes('تفعيل الحساب'));
  });
  check('resolved issue did not silently reopen before the explicit re-raise', () => assert.equal(metrics.repeated_resolved_steps, 0));
  check('context block bounded (< 8000 chars)', () => assert.ok(maxBlockSize < 8000));

  if (fail.length) {
    console.log('\n❌ REPLAY FAILURES:');
    for (const f of fail) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✅ REPLAY PASS — all acceptance invariants held across the conversation.');
})();
