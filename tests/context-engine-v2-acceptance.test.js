'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const {
  validateState, buildConversationStateBlock, detectResolvedReopen,
} = require('../src/services/ai/conversation-state');
const { extractConversationState, loadConversationState, saveConversationState } = require('../src/services/ai/conversation-state.service');
const { resolvePriceComputation, buildPriceComputationBlock, deriveResolvedPricingContext } = require('../src/services/ai/deterministic-calc');

// The extraction LLM output is SIMULATED (as in the existing generic-regression
// suite) — the engine contains no vertical logic, and live extraction quality is
// validated by the replay/benchmark. Adobe/Tamara here are test fixtures only.

function mockAi(json) {
  return { raw: async () => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] }) };
}
function withStateFlag(fn) {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  try { return fn(); } finally { process.env.CONVERSATION_STATE_ENABLED = prev; }
}
function client(config) { return new AIClient(config, { info() {}, warn() {}, error() {} }); }
function promptWith(config, state, latestUserText, history = []) {
  return withStateFlag(() => client(config).buildSystemPrompt(
    history.length ? history : [{ role: 'user', content: latestUserText }],
    { conversationState: state, conversationStateCanInject: true, latestUserText },
  ));
}

// In-memory tenant-scoped store proving real (user_id, conversation_id) isolation.
function fakeDb() {
  const store = new Map();
  const key = (u, c) => `${u}|${c}`;
  return {
    _store: store,
    isConfigured: () => true,
    async query(sql, params) {
      if (/SELECT/i.test(sql) && /FROM conversation_states/i.test(sql)) {
        const row = store.get(key(params[0], params[1]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO conversation_states/i.test(sql)) {
        const [u, c, , , state, reflects] = params;
        const k = key(u, c);
        const existing = store.get(k);
        if (state !== undefined) {
          store.set(k, { user_id: u, conversation_id: c, state: JSON.parse(state), state_version: (existing?.state_version || 0) + 1, reflects_message_id: reflects || null, extraction_ok: true });
        } else {
          store.set(k, existing ? { ...existing, extraction_ok: false } : { user_id: u, conversation_id: c, state: null, state_version: 0, reflects_message_id: null, extraction_ok: false });
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ── Test A — 20+ message reference resolution ──────────────────────────────
test('A: a short reference after 20+ messages resolves to the earlier entity — no "which one?"', () => {
  const history = [{ role: 'user', content: 'أبي اشتراك Adobe' }];
  for (let i = 0; i < 22; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: `رسالة جانبية ${i}` });
  history.push({ role: 'user', content: 'طيب الاشتراك مضمون؟' });
  const state = validateState({
    active_entities: [{ type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe', confidence: 'high', last_seen: '1' }],
    last_turn_understanding: { intent: 'ask_warranty', resolved_references: [{ text: 'الاشتراك', entity: 'اشتراك Adobe', confidence: 'high' }] },
  });
  const sys = promptWith({ storeName: 'x', products: [{ name: 'اشتراك Adobe', price: 100 }] }, state, 'طيب الاشتراك مضمون؟', history);
  assert.ok(sys.includes('الاشتراك') && sys.includes('اشتراك Adobe'), 'reference rendered resolved');
  assert.ok(/معلومة معروفة/.test(sys), 'told not to re-ask known info');
  assert.ok(!/❓/.test(sys), 'no clarifying-price question injected');
});

// ── Test B — topic switch A → B → "كم سعره؟" ───────────────────────────────
test('B: after switching product A→B, "كم سعره؟" prices B', () => {
  const config = { products: [{ name: 'كانفا', price: 50 }, { name: 'أدوبي', price: 189 }] };
  const state = validateState({
    active_entities: [
      { type: 'product', ref: 'canva', label: 'كانفا', last_seen: '2' },
      { type: 'product', ref: 'adobe', label: 'أدوبي', last_seen: '6' },
    ],
  });
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم سعره؟', config, resolvedContext: deriveResolvedPricingContext(state) });
  assert.equal(res.status, 'computed');
  assert.equal(res.product.name, 'أدوبي');
  assert.equal(res.computation.total, 189);
});

// ── Test C — return to an old topic via explicit reference ─────────────────
test('C: returning to product A (reference compatible only with A) recovers A context', () => {
  const state = validateState({
    active_entities: [
      { type: 'product', ref: 'a', label: 'برنامج A', last_seen: '3' },
      { type: 'product', ref: 'b', label: 'برنامج B', last_seen: '8' },
    ],
    last_turn_understanding: { resolved_references: [{ text: 'الأول', entity: 'برنامج A', confidence: 'high' }] },
  });
  const sys = promptWith({ storeName: 'x' }, state, 'رجعنا للأول، كيف أفعّله؟');
  assert.ok(sys.includes('برنامج A'), 'A recovered from context');
});

// ── Test D — genuine ambiguity → ONE clarification, never escalation ────────
test('D: two equal products at a price question → ONE clarification, no escalation', () => {
  const config = { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] };
  const res = resolvePriceComputation({
    history: [{ role: 'user', content: 'الفرق بين باقة سيلفر و باقة قولد؟' }],
    latestUserText: 'كم؟', config,
  });
  assert.equal(res.status, 'ambiguous_product');
  const block = buildPriceComputationBlock(res);
  assert.ok(/سؤالاً توضيحياً واحداً/.test(block), 'asks exactly one clarification');
  assert.ok(/لا تصعّد|لا تحوّله/.test(block), 'explicitly no escalation');
});

// ── Test E — correction monthly → yearly ───────────────────────────────────
test('E: correction from monthly to yearly makes yearly the priced variant', () => {
  const config = { products: [{ name: 'اشتراك', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] }] };
  const state = validateState({
    active_entities: [
      { type: 'product', ref: 'sub', label: 'اشتراك', last_seen: '1' },
      { type: 'variant', ref: 'monthly', label: 'شهري', last_seen: '2' },
      { type: 'variant', ref: 'yearly', label: 'سنوي', last_seen: '5' }, // newer = the correction
    ],
    last_turn_understanding: { customer_correction: true },
  });
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم يطلع؟', config, resolvedContext: deriveResolvedPricingContext(state) });
  assert.equal(res.status, 'computed');
  assert.equal(res.variant.label, 'سنوي');
  assert.equal(res.computation.total, 200);
});

// ── Test F — pending expectation (bot asked for a phone) ────────────────────
test('F: a pending expectation tells the model a short reply answers the previous question', () => {
  const state = validateState({ pending_expectation: { type: 'phone_number', purpose: 'إرسال طلب الدفع' } });
  const sys = promptWith({ storeName: 'x' }, state, '0551234567');
  assert.ok(/بانتظار رد العميل/.test(sys) && /phone_number/.test(sys));
  assert.ok(/فسّره كإجابة/.test(sys), 'interpret short reply as the answer, not a mystery message');
});

// ── Test G — resolved vs open issue ────────────────────────────────────────
test('G: login resolved + activation open → do-not-resuggest login, and reopen guard trips on a login re-suggestion', () => {
  const state = validateState({
    resolved_issues: [{ id: 'l', summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }],
    open_issues: [{ id: 'a', summary: 'تفعيل المنتج', status: 'open' }],
  });
  const sys = promptWith({ storeName: 'x' }, state, 'التفعيل ما ضبط');
  assert.ok(sys.includes('تسجيل الدخول') && /لا تقترحها/.test(sys));
  assert.ok(sys.includes('تفعيل المنتج'));
  // code-level guard: a reply volunteering login steps (customer didn't re-raise) is flagged
  const reopen = detectResolvedReopen('جرب تسجيل الدخول من جديد', state.resolved_issues, 'التفعيل ما ضبط');
  assert.equal(reopen.reopened, true);
});

// ── Test H — action already attempted ──────────────────────────────────────
test('H: an attempted step is surfaced so it is not blindly repeated', () => {
  const state = validateState({ actions_attempted: [{ action: 'إعادة تشغيل الجهاز', outcome: 'failed', confirmed_by: 'customer' }] });
  const sys = promptWith({ storeName: 'x' }, state, 'ما زال ما يشتغل');
  assert.ok(sys.includes('إعادة تشغيل الجهاز') && /لا تُكررها/.test(sys));
});

// ── Test I — payment short reply → deterministic total, no escalation ───────
test('I: bare payment method then "كم؟" → total 207.9, computed (never escalation)', () => {
  const config = { products: [{ name: 'اشتراك Adobe', price: 189 }], pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تمارا', label: 'تمارا' }] };
  const state = validateState({
    active_entities: [
      { type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe', last_seen: '1' },
      { type: 'payment_method', ref: 'tamara', label: 'تمارا', last_seen: '3' },
    ],
    last_turn_understanding: { intent: 'payment_method_selection' },
  });
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم؟', config, resolvedContext: deriveResolvedPricingContext(state) });
  assert.equal(res.status, 'computed');
  assert.equal(res.computation.total, 207.9);
  assert.ok(/calculated_total=207\.9/.test(buildPriceComputationBlock(res)));
});

// ── Test J — system/config truth beats memory/customer claim ────────────────
test('J: config price is authoritative even if memory/known_facts claims another number', () => {
  const config = { products: [{ name: 'المنتج', price: 189 }] };
  const state = validateState({
    known_facts: { السعر: '999' }, // a customer-stated (or laundered) claim
    salient_memories: [{ summary: 'قال العميل السعر 999', source: 'customer' }],
    active_entities: [{ type: 'product', ref: 'p', label: 'المنتج', last_seen: '1' }],
  });
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم سعره؟', config, resolvedContext: deriveResolvedPricingContext(state) });
  assert.equal(res.computation.basePrice, 189);
  assert.equal(res.computation.total, 189);
});

// ── Test K — hallucinated assistant claim never becomes a fact ──────────────
test('K: a bot self-claim is quarantined as unverified, never a known_fact', () => {
  const state = validateState({
    known_facts: {},
    salient_memories: [{ summary: 'وعد البوت بخصم خاص', source: 'assistant' }], // normalised to previous_bot_statement
  });
  assert.equal(state.salient_memories[0].source, 'previous_bot_statement');
  const block = buildConversationStateBlock(state, { canInject: true, latestUserText: 'الخصم' });
  assert.ok(/غير مؤكد/.test(block) && block.includes('وعد البوت بخصم خاص'));
  assert.ok(!/معلومات مؤكدة[^]*وعد البوت/.test(block), 'not under confirmed facts');
});

// ── Test L — extraction failure is fail-soft ───────────────────────────────
test('L: extraction failure keeps the reply path alive and never injects stale state as truth', async () => {
  const prior = { active_topic: 'قديم' };
  const throwing = { raw: async () => { throw new Error('boom'); } };
  const out = await extractConversationState({ userId: 'u', conversationId: 'c', previousState: prior, newTurns: [{ role: 'user', content: 'x' }], aiClient: throwing });
  assert.equal(out.extraction_ok, false);
  assert.equal(out.state.active_topic, 'قديم'); // prior kept as a seed…
  // …but the caller must NOT inject it: canInject is false → empty block
  assert.equal(buildConversationStateBlock(out.state, { canInject: false }), '');
});

// ── Test M — multi-tenant isolation (same conversation_id, different tenants)
test('M: two tenants sharing a conversation_id never see each other\'s state', async () => {
  const db = fakeDb();
  await saveConversationState({ userId: 'A', conversationId: 'shared', sender: 'sA', state: validateState({ active_topic: 'موضوع A', known_facts: { k: 'A' } }), extractionOk: true, database: db });
  await saveConversationState({ userId: 'B', conversationId: 'shared', sender: 'sB', state: validateState({ active_topic: 'موضوع B', known_facts: { k: 'B' } }), extractionOk: true, database: db });
  const a = await loadConversationState({ userId: 'A', conversationId: 'shared', database: db });
  const b = await loadConversationState({ userId: 'B', conversationId: 'shared', database: db });
  assert.equal(a.state.active_topic, 'موضوع A');
  assert.equal(b.state.active_topic, 'موضوع B');
  assert.equal(a.state.known_facts.k, 'A');
  assert.equal(b.state.known_facts.k, 'B');
});

// ── Test N — multi-conversation isolation (same tenant, two conversations) ──
test('N: one tenant\'s two conversations keep separate state', async () => {
  const db = fakeDb();
  await saveConversationState({ userId: 'U', conversationId: 'c1', sender: 's1', state: validateState({ active_topic: 'محادثة 1' }), extractionOk: true, database: db });
  await saveConversationState({ userId: 'U', conversationId: 'c2', sender: 's2', state: validateState({ active_topic: 'محادثة 2' }), extractionOk: true, database: db });
  const c1 = await loadConversationState({ userId: 'U', conversationId: 'c1', database: db });
  const c2 = await loadConversationState({ userId: 'U', conversationId: 'c2', database: db });
  assert.equal(c1.state.active_topic, 'محادثة 1');
  assert.equal(c2.state.active_topic, 'محادثة 2');
});
