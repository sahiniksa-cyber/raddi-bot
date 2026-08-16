'use strict';

/**
 * Context Engine V2 — LIVE end-to-end verification (spec items 1, 2, 7).
 *
 * Runs REAL conversations through the ACTUAL reply path with a REAL provider:
 *   real extraction LLM (mirrors extractConversationState, exposing usage)
 *     → validate/reconcile state
 *     → CURRENT CONTEXT block
 *     → pricing/context consumers (deriveResolvedPricingContext + computePrice)
 *     → MAIN reply model (AIClient.getReply → validators + quality gate)
 *     → deterministic escalation + prepareEscalation (final customer text)
 * and prints the FINAL text that would be sent to the customer — no hand-built
 * state anywhere. The bot turns are the model's own real replies.
 *
 * Scenarios: the payment failure (item 2) + reference scenarios A–H (item 7) +
 * a dedicated 50-customer-turn extraction-stability run. Real provider `usage`
 * (output tokens per extraction) is aggregated → p50/p95/max.
 *
 * PROVIDER: set exactly one of these env vars (a STAGING/test key — never prod):
 *   CONTEXT_LIVE_OPENAI_API_KEY | CONTEXT_LIVE_OPENROUTER_API_KEY | CONTEXT_LIVE_GOOGLE_API_KEY
 * optional: CONTEXT_LIVE_MODEL. Or CONTEXT_LIVE_CONFIG=/path/tenant.json (staging
 * tenant config). If NO key is available the script prints BLOCKED for every live
 * item and exits 0 (never a false PASS).
 *
 * The token capture reuses ONLY the pure exported building blocks
 * (compactStateForExtraction/buildExtractionRequest/parseExtractionResponse/
 * reconcileSystemState/mergePreservedMemories) — no change to production behaviour.
 *
 * Run (staging): CONTEXT_LIVE_OPENAI_API_KEY=sk-... node scripts/context-engine-v2-live.js
 */

const AIClient = require('../lib/ai-client');
const {
  validateState, compactStateForExtraction, buildExtractionRequest, parseExtractionResponse,
  reconcileSystemState, mergePreservedMemories, buildStateTrace, detectResolvedReopen,
} = require('../src/services/ai/conversation-state');
const { deriveResolvedPricingContext, resolvePriceComputation } = require('../src/services/ai/deterministic-calc');
const { prepareEscalation } = require('../src/workers/escalation-routing');

process.env.CONVERSATION_STATE_ENABLED = 'true';

// ── Merchant config (generic; "X" = تقسيط, a payment CONDITION not a company) ──
const BASE_CONFIG = {
  storeName: 'متجر اختبار',
  employeeName: 'موظف خدمة العملاء',
  products: [{ name: 'اشتراك التصميم', price: 189 }],
  pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }],
  botInstructions: 'أنت موظف خدمة عملاء لمتجر اشتراكات تصميم. اشرح باختصار وأدب. بعد أن يختار العميل طريقة الدفع، اطلب منه رقم الجوال لإرسال طلب الدفع. لا تعرض التحويل لمختص إلا إذا طلب العميل صراحة موظفاً بشرياً.',
};

function resolveLiveConfig() {
  const base = { ...BASE_CONFIG };
  const fromFile = process.env.CONTEXT_LIVE_CONFIG;
  if (fromFile) {
    try { Object.assign(base, JSON.parse(require('fs').readFileSync(fromFile, 'utf8'))); } catch (e) { console.error('CONTEXT_LIVE_CONFIG unreadable:', e.message); }
  }
  if (process.env.CONTEXT_LIVE_OPENAI_API_KEY) base.openaiApiKey = process.env.CONTEXT_LIVE_OPENAI_API_KEY;
  if (process.env.CONTEXT_LIVE_OPENROUTER_API_KEY) base.openrouterApiKey = process.env.CONTEXT_LIVE_OPENROUTER_API_KEY;
  if (process.env.CONTEXT_LIVE_GOOGLE_API_KEY) base.googleApiKey = process.env.CONTEXT_LIVE_GOOGLE_API_KEY;
  if (process.env.CONTEXT_LIVE_MODEL) base.model = process.env.CONTEXT_LIVE_MODEL;
  const hasKey = base.openaiApiKey || base.openrouterApiKey || base.googleApiKey;
  return hasKey ? base : null;
}

// Faithful mirror of extractConversationState that ALSO returns provider usage.
// Uses only the pure exported helpers — identical logic, no production change.
async function extractWithUsage(ai, { previousState, newTurns, lastBotReply, systemFacts = {} }) {
  const prior = validateState(previousState);
  const latestText = [...(Array.isArray(newTurns) ? newTurns : [])].reverse().find((t) => t && t.role !== 'assistant')?.content || '';
  const compacted = compactStateForExtraction(prior, { latestText });
  const req = buildExtractionRequest({ previousState: compacted, newTurns, lastBotReply });
  try {
    const resp = await ai.raw(req);
    const usage = resp && resp.usage ? resp.usage : null;
    const content = resp?.choices?.[0]?.message?.content || '';
    const parsed = parseExtractionResponse(content);
    if (!parsed.extraction_ok) return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false, usage };
    const withMemories = { ...parsed.state, salient_memories: mergePreservedMemories(parsed.state.salient_memories, prior.salient_memories) };
    return { state: reconcileSystemState(withMemories, systemFacts), extraction_ok: true, usage };
  } catch (_) {
    return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false, usage: null };
  }
}

function outputTokensOf(usage) {
  if (!usage) return null;
  const v = usage.completion_tokens != null ? usage.completion_tokens
    : (usage.output_tokens != null ? usage.output_tokens : null);
  return Number.isFinite(Number(v)) ? Number(v) : null;
}
function pctile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function tokenStats(samples) {
  return { count: samples.length, p50: pctile(samples, 50), p95: pctile(samples, 95), max: samples.length ? Math.max(...samples) : null };
}

function scrub(text) {
  return String(text || '')
    .replace(/\d[\d\s-]{6,}\d/g, '[رقم محجوب]')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[بريد محجوب]');
}
const softNoClarify = (r) => !/أي\s+(منتج|باقة|اشتراك|مشكلة|واحد)/.test(String(r || ''));
const softOneClarify = (r) => /\?|؟/.test(String(r || '')) && /أي\s+(باقة|واحد|منتج)/.test(String(r || ''));

// ── Scenarios: item 2 (payment) + item 7 (A–H) ─────────────────────────────
const B_CONFIG = { products: [{ name: 'برنامج ألفا', price: 100 }, { name: 'برنامج بيتا', price: 200 }] };
const D_CONFIG = { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] };
const E_CONFIG = { products: [{ name: 'اشتراك التصميم', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] }] };

const scenarios = [
  {
    id: 'PAYMENT (item 2)',
    turns: [
      { c: 'السلام عليكم، عندكم اشتراك التصميم؟' },
      { c: 'تمام أبيه' },
      { c: 'تقسيط', expect: { intentIncludes: ['payment', 'دفع', 'select'], noEscalation: true } },
      { c: 'كم؟', expect: { total: 207.9, noEscalation: true, noClarification: true } },
    ],
  },
  {
    id: 'A: 20+ turn reference',
    build: () => {
      const t = [{ c: 'أبي اشتراك التصميم' }];
      for (let i = 0; i < 20; i++) t.push({ c: `عندي سؤال جانبي رقم ${i}، كم مدة التوصيل عادة؟` });
      t.push({ c: 'طيب الاشتراك مضمون؟', expect: { noEscalation: true, referenceResolvedTo: 'التصميم', noClarification: true } });
      return t;
    },
  },
  {
    id: 'B: topic switch A→B then price',
    config: B_CONFIG,
    turns: [
      { c: 'عندكم برنامج ألفا؟' },
      { c: 'طيب وبرنامج بيتا؟' },
      { c: 'كم سعره؟', expect: { activeEntityIncludes: 'بيتا', noEscalation: true } },
    ],
  },
  {
    id: 'C: return to old topic A',
    turns: [
      { c: 'أبي اشتراك التصميم' },
      { c: 'بس أول شي، كم رسوم الشحن عندكم؟' },
      { c: 'خلاص رجعنا للي كنا فيه، هو مضمون؟', expect: { referenceResolvedTo: 'التصميم', noEscalation: true, noClarification: true } },
    ],
  },
  {
    id: 'D: genuine ambiguity',
    config: D_CONFIG,
    turns: [
      { c: 'وش الفرق بين باقة سيلفر و باقة قولد؟' },
      { c: 'كم؟', expect: { oneClarification: true, noEscalation: true } },
    ],
  },
  {
    id: 'E: correction monthly→yearly',
    config: E_CONFIG,
    turns: [
      { c: 'أبي الاشتراك الشهري' },
      { c: 'لا خلاص الأفضل السنوي' },
      { c: 'طيب كم يطلع؟', expect: { total: 200, noEscalation: true } },
    ],
  },
  {
    id: 'F: pending expectation (phone)',
    turns: [
      { c: 'أبي اشتراك التصميم وأدفع تقسيط' },
      { c: '0500000000', expect: { noEscalation: true } },
    ],
  },
  {
    id: 'G: solved login → activation (no repeat login)',
    turns: [
      { c: 'ما أقدر أسجّل دخول لحسابي' },
      { c: 'تمام ضبط دخلت الحين' },
      { c: 'بس التفعيل ما يشتغل', expect: { noEscalation: true, noReopenOf: 'دخول' } },
    ],
  },
  {
    id: 'H: payment method alone',
    turns: [
      { c: 'مهتم باشتراك التصميم' },
      { c: 'تقسيط', expect: { noEscalation: true, intentIncludes: ['payment', 'دفع', 'select'] } },
    ],
  },
];

// ── Dedicated 50-customer-turn extraction-stability scenario (item 2) ───────
function buildFiftyTurnScenario() {
  const turns = [];
  const push = (c) => turns.push({ c });
  push('السلام عليكم');
  push('عندكم اشتراك التصميم؟');
  push('كم سعره؟');
  push('طيب فيه باقات ثانية؟');
  push('وش الفرق بينها؟');
  push('أبي الأفضل');
  push('لا خلاص الأرخص');
  push('كيف أدفع؟');
  push('تقسيط');
  push('كم يطلع بالتقسيط؟');
  push('طيب عندي مشكلة ما أقدر أفعّل الحساب');
  push('جربت وما زبط');
  push('لا نفس المشكلة');
  push('رقم طلبي 10234');
  push('تمام تفعّل الحين شكراً');
  push('بخصوص نفس الاشتراك مضمون؟');
  push('كم مدة الضمان؟');
  push('طيب عندكم شحن؟');
  push('كم رسومه؟');
  push('يوصل خلال كم يوم؟');
  push('طيب رجعنا للاشتراك، أقدر أغيّر الباقة بعدين؟');
  push('لو غيّرت رأيي أقدر أسترجع؟');
  push('كيف الاسترجاع؟');
  push('طيب خلني أفكر');
  push('رجعت، أبي أكمل الطلب');
  push('نفس طريقة الدفع اللي قلت عنها');
  push('أرسلت المبلغ');
  push('متى يوصلني الكود؟');
  push('ما جاني شي لين الحين');
  push('طيب أنتظر');
  push('جاني الكود بس ما يشتغل');
  push('كتبته صح وأكيد');
  push('طيب جرّبت من جهاز ثاني');
  push('اشتغل الحين تمام');
  push('عندي سؤال ثاني عن برنامج مختلف');
  push('كم سعره؟');
  push('لا رجعنا للأول');
  push('هذا يشتغل على ويندوز؟');
  push('وعلى الجوال؟');
  push('طيب زين');
  push('فيه خصم لو أخذت أكثر من واحد؟');
  push('كم الخصم؟');
  push('طيب أبي اثنين');
  push('نفس الدفع');
  push('أكدت التحويل');
  push('شكراً على المساعدة');
  push('آخر سؤال، عندكم فواتير ضريبية؟');
  push('تمام أبي فاتورة');
  push('على نفس الإيميل');
  push('يعطيك العافية خلصنا');
  return { id: 'FIFTY: 50-turn extraction stability', turns, stability: true };
}

async function runScenario(sc, config, tokenSamples) {
  const scConfig = sc.config ? { ...config, ...sc.config } : config;
  const ai = new AIClient(scConfig, { info() {}, warn() {}, error() {} });
  const turns = sc.build ? sc.build() : sc.turns;
  const history = [];
  let state = {};
  let pass = true; const notes = [];
  let extractOk = 0; let extractTotal = 0;

  for (const turn of turns) {
    history.push({ role: 'user', content: turn.c });
    extractTotal++;
    const t0 = Date.now();
    const ex = await extractWithUsage(ai, {
      previousState: state, newTurns: [{ role: 'user', content: turn.c }],
      lastBotReply: [...history].reverse().find((m) => m.role === 'assistant')?.content || '',
      systemFacts: { escalationPending: false },
    });
    const latency = Date.now() - t0;
    if (ex.extraction_ok) extractOk++;
    const tok = outputTokensOf(ex.usage);
    if (tok != null) tokenSamples.push(tok);
    state = ex.state;
    const canInject = ex.extraction_ok;

    let reply = '';
    try {
      reply = String(await ai.getReply(history, {
        conversationState: state, conversationStateCanInject: canInject,
        escalationPending: false, latestUserText: turn.c,
      }) || '').trim();
    } catch (e) { notes.push(`getReply error: ${e.message}`); pass = false; }

    const esc = prepareEscalation({ reply, config: scConfig, customerSender: 's', customerPhoneNumber: 'p', inboundText: turn.c });
    const finalReply = (esc.customerReply || '').trim();
    const escalated = !!esc.ownerMessage || /\[تحويل:/.test(reply);
    history.push({ role: 'assistant', content: finalReply || reply });

    const trace = buildStateTrace(state, { tenantId: 'staging-tenant', conversationId: sc.id, extractionOk: ex.extraction_ok });
    if (!sc.stability) {
      console.log(`\n[${sc.id}] C: ${scrub(turn.c)}`);
      console.log(`   intent=${trace.intent} active=${trace.active_entity} pending=${trace.pending_expectation} refs=${trace.resolved_references} tok=${tok} lat=${latency}ms escalated=${escalated}`);
      console.log(`   BOT: ${scrub(finalReply).slice(0, 200)}`);
    }

    const e = turn.expect;
    if (e) {
      if (e.noEscalation && escalated) { pass = false; notes.push('unexpected escalation'); }
      if (e.total != null && !finalReply.includes(String(e.total))) { pass = false; notes.push(`total ${e.total} not in reply`); }
      if (e.intentIncludes && !e.intentIncludes.some((k) => String(trace.intent || '').toLowerCase().includes(k))) { pass = false; notes.push(`intent "${trace.intent}" not a payment selection`); }
      if (e.referenceResolvedTo && !(state.last_turn_understanding?.resolved_references || []).some((r) => String(r.entity || '').includes(e.referenceResolvedTo))
        && !String(trace.active_entity || '').includes('design') && !(state.active_entities || []).some((x) => String(x.label || '').includes(e.referenceResolvedTo))) { pass = false; notes.push('reference not resolved to A'); }
      if (e.activeEntityIncludes && !(state.active_entities || []).some((x) => String(x.label || '').includes(e.activeEntityIncludes))) { pass = false; notes.push(`active entity not ${e.activeEntityIncludes}`); }
      if (e.noClarification && !softNoClarify(finalReply)) { pass = false; notes.push('unexpected clarification'); }
      if (e.oneClarification && !softOneClarify(finalReply)) { pass = false; notes.push('expected exactly one clarification'); }
      if (e.noReopenOf) {
        const reopened = detectResolvedReopen(finalReply, state.resolved_issues || [], turn.c).reopened;
        if (reopened) { pass = false; notes.push(`re-suggested resolved "${e.noReopenOf}"`); }
      }
    }
  }
  return { id: sc.id, pass, notes, extractOk, extractTotal };
}

async function main() {
  const config = resolveLiveConfig();
  console.log('════════ CONTEXT ENGINE V2 — LIVE VERIFICATION ════════\n');
  if (!config) {
    console.log('⛔ BLOCKED — no provider key available in this environment.');
    console.log('   Set CONTEXT_LIVE_OPENAI_API_KEY / _OPENROUTER_ / _GOOGLE_ (staging key) to run.\n');
    const blocked = [
      'REAL PROVIDER EXTRACTION', 'REAL MAIN REPLY PATH', 'PAYMENT (item 2)',
      'A: 20+ turn reference', 'B: topic switch', 'C: return to old topic', 'D: ambiguity',
      'E: correction', 'F: pending expectation', 'G: solved→new (no repeat)', 'H: payment alone',
      'FIFTY: 50-turn extraction stability',
    ];
    for (const it of blocked) console.log(`${it}: BLOCKED`);
    console.log('LIVE EXTRACTION SUCCESS: BLOCKED');
    console.log('OUTPUT TOKENS p50/p95/max: BLOCKED');
    console.log('LATENCY p50/p95: BLOCKED');
    return 0;
  }

  const tokenSamples = [];
  const results = [];
  for (const sc of scenarios) results.push(await runScenario(sc, config, tokenSamples));
  const fifty = await runScenario(buildFiftyTurnScenario(), config, tokenSamples);
  results.push(fifty);

  console.log('\n════════ LIVE RESULTS ════════');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id}${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`);
  const okTotal = results.reduce((a, r) => a + r.extractOk, 0);
  const total = results.reduce((a, r) => a + r.extractTotal, 0);
  const ts = tokenStats(tokenSamples);
  console.log('\nLIVE EXTRACTION SUCCESS:', `${okTotal}/${total} (${((okTotal / total) * 100).toFixed(1)}%)`);
  console.log('50-TURN EXTRACTION SUCCESS:', `${fifty.extractOk}/${fifty.extractTotal}`);
  console.log('OUTPUT TOKENS p50/p95/max:', ts.p50, '/', ts.p95, '/', ts.max, `(n=${ts.count})`);
  return results.every((r) => r.pass) ? 0 : 1;
}

module.exports = { scenarios, buildFiftyTurnScenario, extractWithUsage, resolveLiveConfig, tokenStats, pctile, outputTokensOf };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
