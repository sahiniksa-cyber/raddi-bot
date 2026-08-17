'use strict';

/**
 * Context Engine V2 — LIVE end-to-end verification (spec items 1, 2, 7).
 *
 * Runs REAL conversations through the ACTUAL reply path with a REAL provider:
 *   real extraction LLM (mirrors extractConversationState, exposing usage)
 *     → validate/reconcile state → CURRENT CONTEXT block
 *     → pricing/context consumers (deriveResolvedPricingContext + computePrice)
 *     → MAIN reply model (AIClient.getReply → validators + quality gate)
 *     → deterministic escalation + prepareEscalation (final customer text)
 * printing the FINAL text that would be sent to the customer. No hand-built state.
 *
 * FALSE-PASS GUARDS (strict): a context assertion FAILS unless the extractor
 * actually succeeded on that turn (extraction_ok === true) — otherwise the main
 * model could answer from raw history and mask a Context Engine failure. Product
 * selection is proven via the DETERMINISTIC computePrice result, pending
 * expectation via its lifecycle (asked → consumed → not re-asked), resolved/open
 * issues via the real state, and 50-turn stability requires a full 50/50.
 *
 * PROVIDER (staging key, never prod): one of CONTEXT_LIVE_OPENAI_API_KEY |
 * CONTEXT_LIVE_OPENROUTER_API_KEY | CONTEXT_LIVE_GOOGLE_API_KEY (+ optional
 * CONTEXT_LIVE_MODEL) or CONTEXT_LIVE_CONFIG=/path/tenant.json. No key → BLOCKED
 * for every live item, exit 0 (never a false PASS). No DB / WhatsApp / flag / prod.
 *
 * Token capture reuses ONLY the exported pure helpers — no production behaviour
 * change. Run (staging): CONTEXT_LIVE_OPENAI_API_KEY=sk-... node scripts/context-engine-v2-live.js
 */

const AIClient = require('../lib/ai-client');
const {
  validateState, compactStateForExtraction, buildExtractionRequest, parseExtractionResponse,
  reconcileSystemState, mergePreservedMemories, buildStateTrace, detectResolvedReopen,
} = require('../src/services/ai/conversation-state');
const { deriveResolvedPricingContext, resolvePriceComputation } = require('../src/services/ai/deterministic-calc');
const { prepareEscalation } = require('../src/workers/escalation-routing');
const { applyDeterministicEscalation } = require('../src/services/instruction-routing/escalation-rules');
const { reviewOutgoingReplyBeforeSend } = require('../src/services/ai/pre-send-review');

// Mirror production flags in-process (never touches Railway). Both are ON in prod.
process.env.CONVERSATION_STATE_ENABLED = 'true';
process.env.INSTRUCTION_ROUTING_ENABLED = 'true';

const TOKEN_METRICS_MIN_SAMPLES = 20; // below this we cannot honestly report percentiles

// ── Merchant config (generic; "X" = تقسيط, a payment CONDITION not a company) ──
const BASE_CONFIG = {
  storeName: 'متجر اختبار',
  employeeName: 'موظف خدمة العملاء',
  products: [{ name: 'اشتراك التصميم', price: 189 }],
  pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }],
  botInstructions: 'أنت موظف خدمة عملاء لمتجر اشتراكات تصميم. اشرح باختصار وأدب. طرق الدفع المتاحة: نقدًا أو بالتقسيط. عند اختيار التقسيط تُضاف رسوم 10% على السعر الأساسي (النظام يحسب الإجمالي تلقائيًا). بعد أن يختار العميل طريقة الدفع، اطلب منه رقم الجوال لإرسال طلب الدفع. لا تعرض التحويل لمختص إلا إذا طلب العميل صراحة موظفاً بشرياً.',
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
async function extractWithUsage(ai, { previousState, newTurns, lastBotReply, systemFacts = {} }) {
  const prior = validateState(previousState);
  const latestText = [...(Array.isArray(newTurns) ? newTurns : [])].reverse().find((t) => t && t.role !== 'assistant')?.content || '';
  const compacted = compactStateForExtraction(prior, { latestText });
  const req = buildExtractionRequest({ previousState: compacted, newTurns, lastBotReply });
  const looksTruncated = (c) => {
    const s = String(c || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return s.startsWith('{') && !s.endsWith('}');
  };
  try {
    let resp = await ai.raw(req);
    let usage = resp && resp.usage ? resp.usage : null;
    let content = resp?.choices?.[0]?.message?.content || '';
    let parsed = parseExtractionResponse(content);
    // Bug 4: retry once at a higher bounded ceiling on truncation (mirrors the
    // production extractConversationState so the 50-turn stability is measured
    // against the same behaviour).
    if (!parsed.extraction_ok && (resp?.choices?.[0]?.finish_reason === 'length' || looksTruncated(content))) {
      const retryCeiling = Math.min(1600, Math.max(1200, Number(process.env.CONVERSATION_STATE_EXTRACT_RETRY_MAX_TOKENS) || 1600));
      resp = await ai.raw({ ...req, max_tokens: retryCeiling });
      usage = resp && resp.usage ? resp.usage : usage;
      content = resp?.choices?.[0]?.message?.content || '';
      parsed = parseExtractionResponse(content);
    }
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
// Honest token verdict: PASS only with enough real usage samples; else BLOCKED.
function tokenMetricsVerdict(samples, min = TOKEN_METRICS_MIN_SAMPLES) {
  return (Array.isArray(samples) && samples.length >= min) ? 'PASS' : 'BLOCKED';
}
// 50-turn stability requires a FULL 50/50 — anything less is FAIL, never PASS.
function stabilityVerdict(extractOk, extractTotal, required = 50) {
  return (extractTotal === required && extractOk === required) ? 'PASS' : 'FAIL';
}

const softNoClarify = (r) => !/(أي|أيّ)\s+(منتج|باقة|اشتراك|مشكلة|واحد)/.test(String(r || ''));
const softOneClarify = (r) => /\?|؟/.test(String(r || '')) && /(أي|أيّ|اي|وش|أيهما)\s+[^؟?]{0,30}(باقة|منتج|اشتراك|خيار|واحد|تفضّل|تفضل|تبغى|تبي)/.test(String(r || ''));
// A REQUEST for the phone (question/imperative) — NOT a confirmation like
// "سأرسل الطلب لرقم الجوال …", which mentions the phone without asking for it.
const asksForPhone = (r) => {
  const s = String(r || '');
  if (/(سأرسل|بأرسل|سوف\s+أرسل|راح\s+أرسل|تم\s+الإرسال|أرسلت)\s+[^؟?]{0,30}(رقم|جوال)/.test(s)) return false;
  return /(زوّدني|زودني|عطني|أعطني|ابغى|أبغى|ممكن|احتاج|أحتاج|ارسل\s+لي|أرسل\s+لي|اكتب\s+لي)\s*[^.؟?]{0,25}(رقم|جوال|هاتف)/.test(s)
    || /(رقم\s*(ال)?جوال|رقمك|جوالك|هاتفك)\s*[؟?]/.test(s);
};

/**
 * PURE, exported assertion checker (so the guards are unit-testable without a
 * provider). Returns { pass, notes }. Any `expect` implicitly REQUIRES
 * ctx.extraction_ok === true on that turn (opt out with requiresExtraction:false).
 */
function checkExpect(expect, ctx) {
  const notes = [];
  if (!expect) return { pass: true, notes };
  if (expect.requiresExtraction !== false && ctx.extraction_ok !== true) notes.push('extraction_ok !== true on target turn');

  if (expect.noEscalation && ctx.escalated) notes.push('unexpected escalation');
  if (expect.intentIncludes && !expect.intentIncludes.some((k) => String(ctx.intent || '').toLowerCase().includes(k))) notes.push(`intent "${ctx.intent}" not a match`);
  if (expect.total != null) {
    if (ctx.priceTotal !== expect.total) notes.push(`deterministic total ${ctx.priceTotal} !== ${expect.total}`);
    if (!String(ctx.finalReply).includes(String(expect.total))) notes.push(`total ${expect.total} not in reply`);
  }
  if (expect.selectedProduct) {
    if (ctx.priceStatus !== 'computed') notes.push(`price not computed (status=${ctx.priceStatus})`);
    if (!String(ctx.priceProductName || '').includes(expect.selectedProduct)) notes.push(`selected product "${ctx.priceProductName}" != ${expect.selectedProduct}`);
  }
  if (expect.referenceResolvedTo) {
    const inRefs = (ctx.resolvedReferences || []).some((r) => String(r.entity || '').includes(expect.referenceResolvedTo));
    const inActive = (ctx.activeEntities || []).some((e) => String(e.label || '').includes(expect.referenceResolvedTo)) && String(ctx.activeEntityLabel || '').includes(expect.referenceResolvedTo);
    if (!inRefs && !inActive) notes.push(`reference not resolved to "${expect.referenceResolvedTo}"`);
  }
  if (expect.noClarification && !softNoClarify(ctx.finalReply)) notes.push('unexpected clarification');
  if (expect.oneClarification && !softOneClarify(ctx.finalReply)) notes.push('expected exactly one clarification');
  if (expect.botAsksPhone && !asksForPhone(ctx.finalReply)) notes.push('bot did not ask for the phone');
  if (expect.pendingBecomes && !(ctx.pending && String(ctx.pending.type || '').includes(expect.pendingBecomes))) notes.push(`pending expectation is not "${expect.pendingBecomes}"`);
  if (expect.pendingCleared) {
    const wasPhone = ctx.prevPending && /phone/.test(String(ctx.prevPending.type || ''));
    if (!wasPhone) notes.push('no prior phone expectation to clear');
    else if (ctx.pending && /phone/.test(String(ctx.pending.type || ''))) notes.push('phone expectation not cleared after the answer');
  }
  if (expect.replyNotAskingPhone && asksForPhone(ctx.finalReply)) notes.push('bot re-asked for the phone');
  if (expect.resolvedIncludes && !(ctx.resolvedIssues || []).some((i) => String(i.summary || '').includes(expect.resolvedIncludes))) notes.push(`"${expect.resolvedIncludes}" not in resolved_issues`);
  if (expect.openIncludes && !(ctx.openIssues || []).some((i) => String(i.summary || '').includes(expect.openIncludes))) notes.push(`"${expect.openIncludes}" not in open_issues`);
  if (expect.noReopenOf && ctx.reopenedResolved) notes.push(`re-suggested resolved "${expect.noReopenOf}"`);
  return { pass: notes.length === 0, notes };
}

function scrub(text) {
  return String(text || '').replace(/\d[\d\s-]{6,}\d/g, '[رقم محجوب]').replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[بريد محجوب]');
}

// A pre-send reviewer that calls the REAL production reviewOutgoingReplyBeforeSend
// with the REAL AIClient reviewer (bot.reviewReplyBeforeSend → ai.reviewBeforeSend)
// but a no-write in-memory DB (reads only) and replyMessageId=null (no persist).
function makeLiveReviewer(ai, { userId, conversationId, sender, getHistory }) {
  const bot = { reviewReplyBeforeSend: (input) => ai.reviewBeforeSend(input) };
  const fakeDb = {
    isConfigured: () => true,
    async query(sql) {
      // Serve the pre-send-review "recent history" SELECT from the live history
      // (newest-first, as the real query returns), everything else empty.
      if (/FROM messages/i.test(sql) && /direction = 'inbound'/i.test(sql)) {
        const h = getHistory();
        const base = 1_700_000_000_000; // fixed epoch; only ordering matters
        const rows = h.map((m, i) => ({
          role: m.role,
          direction: m.role === 'user' ? 'inbound' : 'outbound',
          content: m.content,
          status: m.role === 'user' ? 'received' : 'sent',
          raw_payload: null,
          created_at: new Date(base + i * 1000).toISOString(),
        }));
        return { rows: rows.reverse() }; // DESC, like the production query
      }
      return { rows: [] };
    },
  };
  return async ({ draft, source }) => reviewOutgoingReplyBeforeSend({
    database: fakeDb,
    bot,
    payload: { preSendReviewRequired: true, source: source || 'ai_reply', customerId: sender, sender, channelId: 'whatsapp', conversationId },
    userId,
    conversationId,
    replyMessageId: null, // no DB write
    draft,
  });
}

/**
 * The FULL production send-boundary pipeline (no DB/WhatsApp writes):
 *   getReply → applyDeterministicEscalation → prepareEscalation (ai-worker step)
 *   → pre-send AI review (reviewOutgoingReplyBeforeSend) → final prepareEscalation
 *   (the handoff detection routePreSendEscalation performs) → FINAL CUSTOMER TEXT.
 * `escalated` and `finalText` are read AFTER the last layer — not after getReply.
 * Layer fns are injectable so the anti-false-pass tests can force each scenario.
 */
async function runSendPipeline({
  ai, config, history, latestUserText, state, canInject, intent = '', slaBreached = false,
  reviewBeforeSend, sender = 's', userId = 'u', conversationId = 'c', getReplyImpl,
}) {
  const routingEnabled = process.env.INSTRUCTION_ROUTING_ENABLED === 'true';
  const draft = getReplyImpl
    ? String(await getReplyImpl() || '').trim()
    : String(await ai.getReply(history, { conversationState: state, conversationStateCanInject: canInject, escalationPending: false, latestUserText }) || '').trim();

  // Layer 2: deterministic escalation (may inject a [تحويل:] marker).
  let reply = draft; let detEscalated = false;
  if (routingEnabled) {
    const det = applyDeterministicEscalation(reply, config, { text: latestUserText, intent, slaBreached });
    reply = det.reply; detEscalated = det.escalated === true;
  }
  // Layer 3: ai-worker escalation prep.
  const esc1 = prepareEscalation({ reply, config, customerSender: sender, customerPhoneNumber: null, inboundText: latestUserText });
  const escalated1 = !!esc1.ownerMessage;
  const draftForSend = String(esc1.customerReply || '').trim();

  // Layer 4: pre-send AI review (fail-closed in prod; here it may rewrite/suppress).
  const preSend = await reviewBeforeSend({ draft: draftForSend, source: 'ai_reply' });
  if (preSend && preSend.suppressed) {
    return { draft, finalText: null, status: 'suppressed', suppressed: true, escalated: detEscalated || escalated1, requiresHuman: preSend.requiresHuman === true };
  }
  // Layer 5: final handoff detection at the send boundary (the same prepareEscalation
  // that routePreSendEscalation runs) — on the POST-REVIEW text.
  const reviewedReply = String((preSend && preSend.reply) || draftForSend).trim();
  const finalEsc = prepareEscalation({ reply: reviewedReply, config, customerSender: sender, customerPhoneNumber: null, inboundText: latestUserText });
  const finalText = String(finalEsc.customerReply || '').trim();
  const escalated = detEscalated || escalated1 || (preSend && preSend.requiresHuman === true) || !!finalEsc.ownerMessage;
  return { draft, finalText, status: 'sent', suppressed: false, escalated, requiresHuman: preSend ? preSend.requiresHuman === true : false };
}

// ── Scenarios ──────────────────────────────────────────────────────────────
const B_CONFIG = { products: [{ name: 'برنامج ألفا', price: 100 }, { name: 'برنامج بيتا', price: 200 }] };
const D_CONFIG = { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] };
// E is a variant-correction test, NOT a payment one — give it its own instructions
// so the base config's installment clause does not leak in and make the model
// speculatively quote a fee instead of the base variant price.
const E_CONFIG = {
  products: [{ name: 'اشتراك التصميم', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] }],
  botInstructions: 'أنت موظف خدمة عملاء لمتجر اشتراكات تصميم. اشرح باختصار وأدب. اذكر السعر الأساسي للباقة التي يختارها العميل كما هو، ولا تفترض طريقة دفع ولا تُضف أي رسوم غير مذكورة.',
};

const scenarios = [
  { id: 'PAYMENT (item 2)', turns: [
    { c: 'السلام عليكم، عندكم اشتراك التصميم؟' },
    { c: 'تمام أبيه' },
    { c: 'تقسيط', expect: { intentIncludes: ['payment', 'دفع', 'select', 'install', 'تقسيط', 'سداد', 'pay'], noEscalation: true } },
    { c: 'كم؟', expect: { total: 207.9, noEscalation: true, noClarification: true } },
  ] },
  { id: 'A: 20+ turn reference', build: () => {
    const t = [{ c: 'أبي اشتراك التصميم' }];
    for (let i = 0; i < 20; i++) t.push({ c: `عندي سؤال جانبي رقم ${i}، كم مدة التوصيل عادة؟` });
    t.push({ c: 'طيب الاشتراك مضمون؟', expect: { noEscalation: true, referenceResolvedTo: 'التصميم', noClarification: true } });
    return t;
  } },
  { id: 'B: topic switch A→B then price', config: B_CONFIG, turns: [
    { c: 'عندكم برنامج ألفا؟' },
    { c: 'طيب وبرنامج بيتا؟' },
    { c: 'كم سعره؟', expect: { selectedProduct: 'بيتا', total: 200, noEscalation: true } },
  ] },
  { id: 'C: return to old topic A', turns: [
    { c: 'أبي اشتراك التصميم' },
    { c: 'بس أول شي، كم رسوم الشحن عندكم؟' },
    { c: 'خلاص رجعنا للي كنا فيه، هو مضمون؟', expect: { referenceResolvedTo: 'التصميم', noEscalation: true, noClarification: true } },
  ] },
  { id: 'D: genuine ambiguity', config: D_CONFIG, turns: [
    { c: 'وش الفرق بين باقة سيلفر و باقة قولد؟' },
    { c: 'كم؟', expect: { oneClarification: true, noEscalation: true } },
  ] },
  { id: 'E: correction monthly→yearly', config: E_CONFIG, turns: [
    { c: 'أبي الاشتراك الشهري' },
    { c: 'لا خلاص الأفضل السنوي' },
    { c: 'طيب كم يطلع؟', expect: { total: 200, selectedProduct: 'التصميم', noEscalation: true } },
  ] },
  { id: 'F: pending expectation (phone)', turns: [
    { c: 'أبي اشتراك التصميم وأدفع تقسيط', expect: { botAsksPhone: true, noEscalation: true } },
    { c: 'طيب', expect: { pendingBecomes: 'phone' } },
    { c: '0500000000', expect: { pendingCleared: true, replyNotAskingPhone: true, noEscalation: true } },
  ] },
  { id: 'G: solved login → activation (no repeat)', turns: [
    { c: 'ما أقدر أسجّل دخول لحسابي' },
    { c: 'تمام ضبط دخلت الحين' },
    { c: 'بس التفعيل ما يشتغل', expect: { resolvedIncludes: 'دخول', openIncludes: 'تفعيل', noReopenOf: 'دخول', noEscalation: true } },
  ] },
  { id: 'H: payment method alone', turns: [
    { c: 'مهتم باشتراك التصميم' },
    { c: 'تقسيط', expect: { noEscalation: true, intentIncludes: ['payment', 'دفع', 'select', 'install', 'تقسيط', 'سداد', 'pay'] } },
  ] },
];

function buildFiftyTurnScenario() {
  const c = [
    'السلام عليكم', 'عندكم اشتراك التصميم؟', 'كم سعره؟', 'طيب فيه باقات ثانية؟', 'وش الفرق بينها؟',
    'أبي الأفضل', 'لا خلاص الأرخص', 'كيف أدفع؟', 'تقسيط', 'كم يطلع بالتقسيط؟',
    'طيب عندي مشكلة ما أقدر أفعّل الحساب', 'جربت وما زبط', 'لا نفس المشكلة', 'رقم طلبي 10234', 'تمام تفعّل الحين شكراً',
    'بخصوص نفس الاشتراك مضمون؟', 'كم مدة الضمان؟', 'طيب عندكم شحن؟', 'كم رسومه؟', 'يوصل خلال كم يوم؟',
    'طيب رجعنا للاشتراك، أقدر أغيّر الباقة بعدين؟', 'لو غيّرت رأيي أقدر أسترجع؟', 'كيف الاسترجاع؟', 'طيب خلني أفكر', 'رجعت، أبي أكمل الطلب',
    'نفس طريقة الدفع اللي قلت عنها', 'أرسلت المبلغ', 'متى يوصلني الكود؟', 'ما جاني شي لين الحين', 'طيب أنتظر',
    'جاني الكود بس ما يشتغل', 'كتبته صح وأكيد', 'طيب جرّبت من جهاز ثاني', 'اشتغل الحين تمام', 'عندي سؤال ثاني عن برنامج مختلف',
    'كم سعره؟', 'لا رجعنا للأول', 'هذا يشتغل على ويندوز؟', 'وعلى الجوال؟', 'طيب زين',
    'فيه خصم لو أخذت أكثر من واحد؟', 'كم الخصم؟', 'طيب أبي اثنين', 'نفس الدفع', 'أكدت التحويل',
    'شكراً على المساعدة', 'آخر سؤال، عندكم فواتير ضريبية؟', 'تمام أبي فاتورة', 'على نفس الإيميل', 'يعطيك العافية خلصنا',
  ].map((t) => ({ c: t }));
  return { id: 'FIFTY: 50-turn extraction stability', turns: c, stability: true };
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
    const prevPending = state && state.pending_expectation ? state.pending_expectation : null;
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

    const rc = deriveResolvedPricingContext(state);
    const price = resolvePriceComputation({ history, latestUserText: turn.c, config: scConfig, resolvedContext: rc });
    const trace = buildStateTrace(state, { tenantId: 'staging-tenant', conversationId: sc.id, extractionOk: ex.extraction_ok });

    // Run the FULL production send-boundary pipeline; escalation/suppression are
    // read AFTER the last layer, not after getReply.
    const reviewer = makeLiveReviewer(ai, { userId: 'staging-tenant', conversationId: sc.id, sender: 's', getHistory: () => history.slice() });
    let pipe = { finalText: '', escalated: false, suppressed: false, requiresHuman: false, status: 'sent' };
    try {
      pipe = await runSendPipeline({
        ai, config: scConfig, history, latestUserText: turn.c, state, canInject: ex.extraction_ok,
        intent: trace.intent || '', reviewBeforeSend: reviewer, sender: 's', userId: 'staging-tenant', conversationId: sc.id,
      });
    } catch (e) { notes.push(`pipeline error: ${e.message}`); pass = false; }
    const finalReply = pipe.finalText || '';
    const escalated = pipe.escalated;
    history.push({ role: 'assistant', content: finalReply || (pipe.suppressed ? '(suppressed)' : '') });

    if (turn.expect) {
      const ctx = {
        extraction_ok: ex.extraction_ok,
        intent: trace.intent,
        activeEntities: state.active_entities || [],
        activeEntityLabel: state.active_entity ? state.active_entity.label : null,
        resolvedReferences: state.last_turn_understanding?.resolved_references || [],
        pending: state.pending_expectation || null,
        prevPending,
        priceStatus: price.status,
        priceProductName: price.product ? price.product.name : null,
        priceTotal: price.computation ? price.computation.total : null,
        finalReply, escalated,
        resolvedIssues: state.resolved_issues || [],
        openIssues: state.open_issues || [],
        reopenedResolved: detectResolvedReopen(finalReply, state.resolved_issues || [], turn.c).reopened,
      };
      const r = checkExpect(turn.expect, ctx);
      if (!r.pass) { pass = false; notes.push(`turn "${scrub(turn.c)}": ${r.notes.join('; ')}`); }
    }

    if (!sc.stability) {
      console.log(`\n[${sc.id}] C: ${scrub(turn.c)}`);
      console.log(`   ok=${ex.extraction_ok} intent=${trace.intent} active=${trace.active_entity} pending=${trace.pending_expectation} price=${price.status}${price.computation ? '/' + price.computation.total : ''} tok=${tok} lat=${latency}ms esc=${escalated} status=${pipe.status}`);
      console.log(`   BOT: ${pipe.suppressed ? '(suppressed by pre-send review)' : scrub(finalReply).slice(0, 200)}`);
    }
  }

  // 50-turn stability requires a full 50/50 extraction success.
  if (sc.stability) {
    const verdict = stabilityVerdict(extractOk, extractTotal, turns.length);
    if (verdict !== 'PASS') { pass = false; notes.push(`extraction ${extractOk}/${extractTotal} (< ${turns.length}/${turns.length})`); }
  }
  return { id: sc.id, pass, notes, extractOk, extractTotal };
}

async function main() {
  const config = resolveLiveConfig();
  console.log('════════ CONTEXT ENGINE V2 — LIVE VERIFICATION ════════\n');
  if (!config) {
    console.log('⛔ BLOCKED — no provider key available in this environment.');
    console.log('   Set CONTEXT_LIVE_OPENAI_API_KEY / _OPENROUTER_ / _GOOGLE_ (staging key) to run.\n');
    for (const sc of scenarios) console.log(`${sc.id}: BLOCKED`);
    console.log('FIFTY: 50-turn extraction stability: BLOCKED');
    console.log('LIVE EXTRACTION SUCCESS: BLOCKED');
    console.log('50-TURN EXTRACTION STABILITY: BLOCKED');
    console.log('TOKEN METRICS: BLOCKED');
    console.log('OUTPUT TOKENS p50/p95/max: BLOCKED');
    return 0;
  }

  const tokenSamples = [];
  const results = [];
  for (const sc of scenarios) results.push(await runScenario(sc, config, tokenSamples));
  const fifty = await runScenario(buildFiftyTurnScenario(), config, tokenSamples);
  results.push(fifty);

  console.log('\n════════ LIVE RESULTS ════════');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id}${r.notes.length ? ' — ' + r.notes.join(' | ') : ''}`);
  const okTotal = results.reduce((a, r) => a + r.extractOk, 0);
  const total = results.reduce((a, r) => a + r.extractTotal, 0);
  const ts = tokenStats(tokenSamples);
  const tokenVerdict = tokenMetricsVerdict(tokenSamples);
  console.log('\nLIVE EXTRACTION SUCCESS:', `${okTotal}/${total} (${((okTotal / total) * 100).toFixed(1)}%)`);
  console.log('50-TURN EXTRACTION STABILITY:', stabilityVerdict(fifty.extractOk, fifty.extractTotal, 50), `(${fifty.extractOk}/${fifty.extractTotal})`);
  console.log('TOKEN METRICS:', tokenVerdict, tokenVerdict === 'PASS' ? `→ p50/p95/max = ${ts.p50}/${ts.p95}/${ts.max} (n=${ts.count})` : `(only ${ts.count} usage samples; need ≥ ${TOKEN_METRICS_MIN_SAMPLES})`);
  return results.every((r) => r.pass) ? 0 : 1;
}

module.exports = {
  scenarios, buildFiftyTurnScenario, extractWithUsage, resolveLiveConfig,
  checkExpect, tokenStats, tokenMetricsVerdict, stabilityVerdict, pctile, outputTokensOf,
  runSendPipeline, makeLiveReviewer,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
