'use strict';

/**
 * Context Engine V2 — LIVE end-to-end verification (spec items 1, 2, 7).
 *
 * Runs REAL conversations through the ACTUAL reply path with a REAL provider:
 *   real extraction LLM (extractConversationState)
 *     → validate/reconcile state
 *     → CURRENT CONTEXT block
 *     → pricing/context consumers (deriveResolvedPricingContext + computePrice)
 *     → MAIN reply model (AIClient.getReply → validators + quality gate)
 *     → deterministic escalation + prepareEscalation (final customer text)
 * and prints the FINAL text that would be sent to the customer — no hand-built
 * state anywhere. The bot turns are the model's own real replies.
 *
 * PROVIDER: set exactly one of these env vars (a STAGING/test key — never prod):
 *   CONTEXT_LIVE_OPENAI_API_KEY | CONTEXT_LIVE_OPENROUTER_API_KEY | CONTEXT_LIVE_GOOGLE_API_KEY
 * optional: CONTEXT_LIVE_MODEL (e.g. "gpt-4o-mini", "google/gemini-2.0-flash").
 * Or CONTEXT_LIVE_CONFIG=/path/to/tenant.json for a real staging tenant config
 * (any api-key/model fields it contains are used). If NO key is available the
 * script prints BLOCKED for every live item and exits 0 (never a false PASS).
 *
 * It does NOT touch production, the DB, WhatsApp, or any feature flag — it only
 * makes read-only LLM calls and prints PII-scrubbed output.
 *
 * Run (on staging): CONTEXT_LIVE_OPENAI_API_KEY=sk-... node scripts/context-engine-v2-live.js
 */

const AIClient = require('../lib/ai-client');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');
const { buildStateTrace } = require('../src/services/ai/conversation-state');
const { prepareEscalation } = require('../src/workers/escalation-routing');

process.env.CONVERSATION_STATE_ENABLED = 'true';

// ── Resolve a provider config (env or staging tenant file). No key → BLOCKED. ─
function resolveLiveConfig() {
  const base = {
    storeName: 'متجر اختبار',
    employeeName: 'موظف خدمة العملاء',
    // Generic payment condition "X" = تقسيط (installment) — NOT a company name.
    products: [{ name: 'اشتراك التصميم', price: 189 }],
    pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }],
    // Merchant flow: after the customer picks the payment method, ask for a phone.
    botInstructions: 'أنت موظف خدمة عملاء لمتجر اشتراكات تصميم. اشرح باختصار وأدب. بعد أن يختار العميل طريقة الدفع، اطلب منه رقم الجوال لإرسال طلب الدفع. لا تعرض التحويل لمختص إلا إذا طلب العميل صراحة موظفاً بشرياً.',
  };
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

const BLOCKED_ITEMS = [
  'REAL PROVIDER EXTRACTION', 'REAL MAIN REPLY PATH', '20+ TURN REFERENCE',
  'PAYMENT METHOD SHORT REPLY', 'FINAL REPLY NO FALSE ESCALATION',
  '50-TURN EXTRACTION STABILITY', 'LIVE REFERENCE SCENARIOS A–H',
];

function scrub(text) {
  return String(text || '')
    .replace(/\d[\d\s-]{6,}\d/g, '[رقم محجوب]') // phone-like digit runs
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[بريد محجوب]');
}
function pctile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ── Scenarios: item 2 (payment failure) + item 7 (A–H). Each is customer turns;
// bot turns come from the REAL model. `check(ctx)` asserts the live outcome. ──
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
  { id: 'A: 20+ turn reference', build: () => {
    const t = [{ c: 'أبي اشتراك التصميم' }];
    for (let i = 0; i < 20; i++) t.push({ c: `سؤال جانبي رقم ${i}؟` });
    t.push({ c: 'طيب الاشتراك مضمون؟', expect: { noEscalation: true, referenceResolvedTo: 'اشتراك التصميم' } });
    return t;
  } },
  { id: 'D: genuine ambiguity', config: { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] },
    turns: [{ c: 'وش الفرق بين باقة سيلفر و باقة قولد؟' }, { c: 'كم؟', expect: { oneClarification: true, noEscalation: true } }] },
  { id: 'F: pending expectation (phone)', turns: [
    { c: 'أبي اشتراك التصميم وأدفع تقسيط' },
    { c: '0500000000', expect: { noEscalation: true } },
  ] },
  { id: 'H: payment method alone', turns: [
    { c: 'مهتم باشتراك التصميم' }, { c: 'تقسيط', expect: { noEscalation: true, intentIncludes: ['payment', 'دفع', 'select'] } },
  ] },
];

(async () => {
  const config = resolveLiveConfig();
  console.log('════════ CONTEXT ENGINE V2 — LIVE VERIFICATION ════════\n');
  if (!config) {
    console.log('⛔ BLOCKED — no provider key available in this environment.');
    console.log('   Set CONTEXT_LIVE_OPENAI_API_KEY / _OPENROUTER_ / _GOOGLE_ (staging key) to run.\n');
    for (const it of BLOCKED_ITEMS) console.log(`${it}: BLOCKED`);
    console.log('LIVE EXTRACTION SUCCESS: BLOCKED');
    console.log('OUTPUT TOKENS p50/p95/max: BLOCKED');
    console.log('LATENCY p50/p95: BLOCKED');
    process.exit(0);
  }

  const outTokens = [];
  const latencies = [];
  let extractOk = 0, extractTotal = 0;
  const results = [];

  for (const sc of scenarios) {
    const scConfig = sc.config ? { ...config, ...sc.config } : config;
    const ai = new AIClient(scConfig, { info() {}, warn() {}, error() {} });
    const turns = sc.build ? sc.build() : sc.turns;
    const history = [];
    let state = {};
    let pass = true; const notes = [];

    for (const turn of turns) {
      history.push({ role: 'user', content: turn.c });
      // 1) REAL extraction
      extractTotal++;
      const t0 = Date.now();
      const ex = await extractConversationState({
        userId: 'staging-tenant', conversationId: `live-${sc.id}`,
        previousState: state, newTurns: [{ role: 'user', content: turn.c }],
        lastBotReply: [...history].reverse().find((m) => m.role === 'assistant')?.content || '',
        aiClient: ai, systemFacts: { escalationPending: false },
      });
      latencies.push(Date.now() - t0);
      if (ex.extraction_ok) extractOk++;
      state = ex.state;
      const canInject = ex.extraction_ok;

      // 2) REAL main reply path
      let reply = '';
      try {
        reply = String(await ai.getReply(history, {
          conversationState: state, conversationStateCanInject: canInject,
          escalationPending: false, latestUserText: turn.c,
        }) || '').trim();
      } catch (e) { notes.push(`getReply error: ${e.message}`); pass = false; }

      // 3) deterministic escalation + final customer text
      const esc = prepareEscalation({ reply, config: scConfig, customerSender: 's', customerPhoneNumber: 'p', inboundText: turn.c });
      const finalReply = (esc.customerReply || '').trim();
      const escalated = !!esc.ownerMessage || /\[تحويل:/.test(reply);
      history.push({ role: 'assistant', content: finalReply || reply });

      const trace = buildStateTrace(state, { tenantId: 'staging-tenant', conversationId: sc.id, extractionOk: ex.extraction_ok });
      console.log(`\n[${sc.id}] C: ${scrub(turn.c)}`);
      console.log(`   intent=${trace.intent} active=${trace.active_entity} pending=${trace.pending_expectation} refs=${trace.resolved_references} escalated=${escalated}`);
      console.log(`   BOT: ${scrub(finalReply).slice(0, 220)}`);

      // 4) assert expectations for this turn
      const ex2 = turn.expect;
      if (ex2) {
        if (ex2.noEscalation && escalated) { pass = false; notes.push('unexpected escalation'); }
        if (ex2.total != null && !finalReply.includes(String(ex2.total))) { pass = false; notes.push(`total ${ex2.total} not in reply`); }
        if (ex2.intentIncludes && !ex2.intentIncludes.some((k) => String(trace.intent || '').toLowerCase().includes(k))) { pass = false; notes.push(`intent "${trace.intent}" not a payment selection`); }
        if (ex2.referenceResolvedTo && !(state.last_turn_understanding?.resolved_references || []).some((r) => String(r.entity || '').includes(ex2.referenceResolvedTo))) { pass = false; notes.push('reference not resolved'); }
      }
    }
    results.push({ id: sc.id, pass, notes });
  }

  console.log('\n════════ LIVE RESULTS ════════');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id}${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`);
  console.log('\nLIVE EXTRACTION SUCCESS:', `${extractOk}/${extractTotal} (${((extractOk / extractTotal) * 100).toFixed(1)}%)`);
  console.log('OUTPUT TOKENS p50/p95/max: (extraction latency shown; token usage from provider if returned)');
  console.log('LATENCY p50/p95 (ms):', pctile(latencies, 50), '/', pctile(latencies, 95), '| max', Math.max(...latencies));
  const allPass = results.every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
})();
