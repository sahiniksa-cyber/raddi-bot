'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const NULL_LOG = { info() {}, warn() {}, error() {} };
function client(cfg) { return new AIClient({ model: 'gpt-4o', openaiApiKey: 'x', ...cfg }, NULL_LOG, { record() {} }); }

const STORE_A = {
  storeName: 'متجر أ',
  products: [{ name: 'الباقة X', price: '100 ريال', description: 'باقة' }],
  pricingRules: [{ type: 'percentage_addition', value: 10, label: 'رسوم التقسيط' }],
};
const STORE_B = {
  storeName: 'متجر ب',
  products: [{ name: 'المنتج Z', price: '200', description: 'منتج' }],
  pricingRules: [{ type: 'percentage_addition', value: 5, label: 'رسوم الدفع' }],
};

test('P2: each tenant prompt carries its OWN product price + its OWN pricing rule (no leak)', () => {
  const a = client(STORE_A).buildSystemPrompt([]);
  const b = client(STORE_B).buildSystemPrompt([]);

  // Store A sees only A's product + A's 10% rule.
  assert.match(a, /الباقة X/);
  assert.match(a, /100/);
  assert.match(a, /10\s*%|10%/);
  assert.match(a, /رسوم التقسيط/);
  assert.doesNotMatch(a, /المنتج Z/);
  assert.doesNotMatch(a, /رسوم الدفع/);

  // Store B sees only B's product + B's 5% rule.
  assert.match(b, /المنتج Z/);
  assert.match(b, /5\s*%|5%/);
  assert.doesNotMatch(b, /الباقة X/);
  assert.doesNotMatch(b, /رسوم التقسيط/);
});

test('P2: calc guidance forbids escalating over a calculation and asks one question on ambiguity', () => {
  const a = client(STORE_A).buildSystemPrompt([]);
  assert.match(a, /لا تصعّد|لا تحوّل/);
  assert.match(a, /سؤال|أي باقة|وضّح|حدّد/);
  assert.match(a, /لا تخترع/); // unknown base price → don't invent
});

test('P2 scenario: prior product/package reference REACHES the model (raw history) for "كم؟"', () => {
  const history = [
    { role: 'user', content: 'أبي الباقة X', ts: null },
    { role: 'assistant', content: 'تمام، الباقة X متوفرة', ts: null },
    { role: 'user', content: 'أبي أدفع بالطريقة Y', ts: null },
    { role: 'assistant', content: 'الرسوم حسب إعداد المتجر', ts: null },
    { role: 'user', content: 'كم؟', ts: null },
  ];
  const msgs = client(STORE_A).composeMessages(history, { latestUserText: 'كم؟' });
  // The earlier package reference is present in what the model receives — the
  // model can resolve "كم؟" from context, not lose it.
  const joined = msgs.map((m) => m.content).join('\n');
  assert.match(joined, /الباقة X/);
  assert.match(joined, /كم؟/);
  // The reply path actually RAN computePrice() and injected the computed total as
  // a fact — not "here's 100 and 10%, you do the math".
  assert.match(msgs[0].content, /calculated_total=110/);
});

test('P2: two tenants each get their OWN computed total injected (110 vs 210), no leak', () => {
  const askX = [{ role: 'user', content: 'أبي الباقة X', ts: null }, { role: 'user', content: 'كم؟', ts: null }];
  const askZ = [{ role: 'user', content: 'أبي المنتج Z', ts: null }, { role: 'user', content: 'كم؟', ts: null }];
  const a = client(STORE_A).composeMessages(askX, { latestUserText: 'كم؟' })[0].content;
  const b = client(STORE_B).composeMessages(askZ, { latestUserText: 'كم؟' })[0].content;
  assert.match(a, /calculated_total=110/);
  assert.doesNotMatch(a, /calculated_total=210/);
  assert.match(b, /calculated_total=210/);
  assert.doesNotMatch(b, /calculated_total=110/);
});

test('P2: a tenant with NO pricing rule gets no calc block (zero impact)', () => {
  const plain = client({ storeName: 'متجر', products: [{ name: 'س', price: '50' }] }).buildSystemPrompt([]);
  assert.doesNotMatch(plain, /حساب الأسعار \(قاعدة هذا المتجر/);
});
