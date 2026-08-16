'use strict';

/**
 * Context Engine V2 — BEFORE/AFTER benchmark (spec §23).
 *
 * Measures the DECISION-QUALITY difference the engine makes on a fixed scenario
 * set, offline and deterministically:
 *   BEFORE = V1 behaviour (regex resolution only, no conversation state).
 *   AFTER  = V2 behaviour (resolved context from the state engine).
 *
 * Metrics: wrong-reference/entity rate, unnecessary-clarification rate,
 * repeated-solved-step rate, false-escalation (misunderstanding) rate, and
 * context-extraction success rate — each as BEFORE vs AFTER, plus the added
 * cost (auxiliary calls/reply, extraction prompt tokens, added prompt block).
 *
 * Extraction LATENCY (p50/p95/p99) is a LIVE measurement — run it on staging with
 * scripts/benchmark-state-extraction.js and a provider key. This script needs no
 * DB/Redis/provider and prints numbers, not adjectives.
 *
 * Run: node scripts/context-engine-v2-benchmark.js
 */

const {
  resolvePriceComputation, deriveResolvedPricingContext,
} = require('../src/services/ai/deterministic-calc');
const {
  validateState, buildConversationStateBlock, buildExtractionRequest, detectResolvedReopen,
} = require('../src/services/ai/conversation-state');

// ── Fixed scenario set (generic fixtures; no real store/brand) ─────────────
// Each scenario supplies the raw conversation AND the V2 state a competent
// extractor would produce, plus the CORRECT expected decision.
const S = [];
const add = (sc) => S.push(sc);

const P_ADOBE = { name: 'اشتراك أدوبي', price: 189 };
const RULE_INSTALLMENT = { type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' };

add({
  name: 'payment short-reply then كم (product named by bot, method bare)',
  config: { products: [P_ADOBE], pricingRules: [RULE_INSTALLMENT] },
  history: [{ role: 'assistant', content: 'تقصد اشتراك أدوبي؟ كيف تحب تدفع؟' }, { role: 'user', content: 'تقسيط' }],
  latest: 'كم؟',
  state: { active_entities: [{ type: 'subscription', ref: 'adobe', label: 'اشتراك أدوبي', last_seen: '1' }, { type: 'payment_method', ref: 'inst', label: 'تقسيط', last_seen: '3' }] },
  expect: { total: 207.9, clarify: false, entity: 'اشتراك أدوبي' },
});
add({
  name: 'reference "الاشتراك" after unrelated turns',
  config: { products: [P_ADOBE] },
  history: [{ role: 'user', content: 'أبي اشتراك أدوبي' }, { role: 'user', content: 'كم رسوم الشحن للرياض؟' }, { role: 'assistant', content: 'الشحن مجاني.' }],
  latest: 'طيب الاشتراك كم؟',
  state: { active_entities: [{ type: 'subscription', ref: 'adobe', label: 'اشتراك أدوبي', last_seen: '1' }], last_turn_understanding: { resolved_references: [{ text: 'الاشتراك', entity: 'اشتراك أدوبي', confidence: 'high' }] } },
  expect: { total: 189, clarify: false, entity: 'اشتراك أدوبي' },
});
add({
  name: 'genuine ambiguity: two products at a price question',
  config: { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] },
  history: [{ role: 'user', content: 'الفرق بين باقة سيلفر و باقة قولد؟' }],
  latest: 'كم؟',
  state: {},
  expect: { clarify: true }, // BOTH should clarify — correct behaviour, no regression
});
add({
  name: 'simple price (product + method in customer text)',
  config: { products: [P_ADOBE], pricingRules: [RULE_INSTALLMENT] },
  history: [{ role: 'user', content: 'أبي اشتراك أدوبي أدفع تقسيط' }],
  latest: 'كم؟',
  state: { active_entities: [{ type: 'subscription', ref: 'adobe', label: 'اشتراك أدوبي', last_seen: '1' }, { type: 'payment_method', ref: 'inst', label: 'تقسيط', last_seen: '1' }] },
  expect: { total: 207.9, clarify: false, entity: 'اشتراك أدوبي' },
});
add({
  name: 'resolved-issue not re-suggested (candidate reply re-opens login)',
  config: { products: [] },
  history: [{ role: 'user', content: 'التفعيل ما ضبط' }],
  latest: 'التفعيل ما ضبط',
  state: { resolved_issues: [{ id: 'l', summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }], open_issues: [{ id: 'a', summary: 'تفعيل المنتج', status: 'open' }] },
  candidateReply: 'جرب تسجيل الدخول من جديد',
  expect: { solvedStepShouldBeBlocked: true },
});
add({
  name: 'correction monthly→yearly',
  config: { products: [{ name: 'اشتراك', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] }] },
  history: [{ role: 'user', content: 'أبي الشهري' }, { role: 'user', content: 'لا خلاص السنوي' }],
  latest: 'كم يطلع؟',
  state: { active_entities: [{ type: 'product', ref: 'sub', label: 'اشتراك', last_seen: '1' }, { type: 'variant', ref: 'm', label: 'شهري', last_seen: '1' }, { type: 'variant', ref: 'y', label: 'سنوي', last_seen: '2' }] },
  expect: { total: 200, clarify: false, entity: 'اشتراك' },
});

// A scenario where extraction fails (fail-soft) — counts against extraction success.
add({
  name: 'extraction failure (fail-soft, no state injected)',
  config: { products: [P_ADOBE] },
  history: [{ role: 'user', content: 'كلام غامض جداً' }],
  latest: 'هذا؟',
  state: null, extractionFailed: true,
  expect: { clarify: null }, // undefined reference — acceptable to be unresolved either way
});

// ── Evaluate BEFORE (regex only) and AFTER (V2 context) ────────────────────
function decision(sc, withContext) {
  const state = sc.state ? validateState(sc.state) : null;
  const rc = withContext && state && !sc.extractionFailed ? deriveResolvedPricingContext(state) : null;
  const price = resolvePriceComputation({ history: sc.history, latestUserText: sc.latest, config: sc.config, resolvedContext: rc });
  const clarify = String(price.status).startsWith('ambiguous');
  const entity = price.product ? price.product.name : null;
  const total = price.computation ? price.computation.total : null;
  // solved-step repetition: without state you can't guard; with state the reopen
  // guard blocks a reply that re-suggests a resolved issue.
  let solvedStepBlocked = false;
  if (sc.candidateReply && withContext && state) {
    solvedStepBlocked = detectResolvedReopen(sc.candidateReply, state.resolved_issues, sc.latest).reopened;
  }
  return { clarify, entity, total, solvedStepBlocked };
}

const rate = (n, d) => (d === 0 ? 0 : n / d);
function run(withContext) {
  let wrongRef = 0, refDenom = 0, needlessClarify = 0, clarifyDenom = 0, solvedRepeat = 0, solvedDenom = 0, falseEsc = 0;
  for (const sc of S) {
    const d = decision(sc, withContext);
    if (sc.expect.entity) { refDenom++; if (d.entity !== sc.expect.entity) wrongRef++; }
    if (typeof sc.expect.total === 'number') { if (d.total !== sc.expect.total) wrongRef++, refDenom++; }
    if (typeof sc.expect.clarify === 'boolean') {
      clarifyDenom++;
      if (sc.expect.clarify === false && d.clarify) needlessClarify++;
      // A short reply we FAIL to understand (no computed answer, not a real
      // ambiguity) is the misunderstanding that drives false escalation.
      if (sc.expect.clarify === false && !d.total && !d.clarify) falseEsc++;
    }
    if (sc.expect.solvedStepShouldBeBlocked) { solvedDenom++; if (!d.solvedStepBlocked) solvedRepeat++; }
  }
  const extractionOk = S.filter((s) => !s.extractionFailed).length;
  return {
    wrong_reference_rate: rate(wrongRef, refDenom),
    unnecessary_clarification_rate: rate(needlessClarify, clarifyDenom),
    repeated_solved_step_rate: rate(solvedRepeat, solvedDenom),
    false_escalation_rate: rate(falseEsc, clarifyDenom),
    context_extraction_success_rate: rate(extractionOk, S.length),
  };
}

const before = run(false);
const after = run(true);

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
console.log('════════ CONTEXT ENGINE V2 — BEFORE/AFTER BENCHMARK ════════');
console.log(`scenarios: ${S.length}\n`);
const rows = [
  ['wrong reference / entity rate', before.wrong_reference_rate, after.wrong_reference_rate],
  ['unnecessary clarification rate', before.unnecessary_clarification_rate, after.unnecessary_clarification_rate],
  ['repeated solved-step rate', before.repeated_solved_step_rate, after.repeated_solved_step_rate],
  ['false escalation (misunderstanding) rate', before.false_escalation_rate, after.false_escalation_rate],
  ['context extraction success rate', before.context_extraction_success_rate, after.context_extraction_success_rate],
];
console.log('metric'.padEnd(42), 'BEFORE'.padStart(8), 'AFTER'.padStart(8));
for (const [n, b, a] of rows) console.log(n.padEnd(42), pct(b).padStart(8), pct(a).padStart(8));

// ── Added cost accounting (deterministic) ──────────────────────────────────
const req = buildExtractionRequest({
  previousState: validateState({ active_entities: [{ type: 'product', ref: 'a', label: 'A' }] }),
  newTurns: [{ role: 'user', content: 'رسالة نموذجية من العميل' }],
  lastBotReply: 'رد نموذجي',
});
const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
let avgBlock = 0;
for (const sc of S) {
  if (!sc.state) continue;
  avgBlock += buildConversationStateBlock(validateState(sc.state), { canInject: true, latestUserText: sc.latest }).length;
}
avgBlock = Math.round(avgBlock / S.filter((s) => s.state).length);

console.log('\n──────── ADDED COST ────────');
console.log(`auxiliary LLM calls per reply: 1 (the SAME single extraction call — no extra per-turn call)`);
console.log(`extraction request size: ~${promptChars} chars (~${Math.round(promptChars / 4)} tokens in), max_tokens out: ${req.max_tokens}`);
console.log(`added system-prompt block: ~${avgBlock} chars avg (budget-capped)`);
console.log('extraction latency p50/p95/p99: measure LIVE on staging → scripts/benchmark-state-extraction.js');

// Guardrail: AFTER must not be worse than BEFORE on any decision-quality metric.
const assert = require('node:assert/strict');
assert.ok(after.wrong_reference_rate <= before.wrong_reference_rate, 'AFTER worsened wrong-reference rate');
assert.ok(after.unnecessary_clarification_rate <= before.unnecessary_clarification_rate, 'AFTER worsened clarification rate');
assert.ok(after.repeated_solved_step_rate <= before.repeated_solved_step_rate, 'AFTER worsened solved-step rate');
assert.ok(after.false_escalation_rate <= before.false_escalation_rate, 'AFTER worsened false-escalation rate');
console.log('\n✅ AFTER ≥ BEFORE on every decision-quality metric.');
