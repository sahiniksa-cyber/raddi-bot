'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computePrice,
  parseAmount,
  buildCalculationBlock,
} = require('../src/services/ai/deterministic-calc');

// ── parseAmount: never invents a number ───────────────────────────────
test('parseAmount reads numbers from numbers and price strings; unknown → null', () => {
  assert.equal(parseAmount(100), 100);
  assert.equal(parseAmount('200'), 200);
  assert.equal(parseAmount('99 ريال'), 99);
  assert.equal(parseAmount('1,250 ر.س'), 1250);
  assert.equal(parseAmount('حسب الطلب'), null); // no number → unknown, never fabricated
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

// ── computePrice: tenant-configured rule, deterministic ───────────────
test('Store A: base 100 + 10% = 110 (percentage_addition from tenant config)', () => {
  const r = computePrice({ basePrice: 100, rule: { type: 'percentage_addition', value: 10 } });
  assert.equal(r.ok, true);
  assert.equal(r.total, 110);
  assert.equal(r.subtotal, 100);
});

test('Store B: base 200 + 5% = 210 (different tenant, different rule)', () => {
  const r = computePrice({ basePrice: 200, rule: { type: 'percentage_addition', value: 5 } });
  assert.equal(r.ok, true);
  assert.equal(r.total, 210);
});

test('percentage_discount / fixed_addition / fixed_discount / none', () => {
  assert.equal(computePrice({ basePrice: 200, rule: { type: 'percentage_discount', value: 25 } }).total, 150);
  assert.equal(computePrice({ basePrice: 100, rule: { type: 'fixed_addition', value: 15 } }).total, 115);
  assert.equal(computePrice({ basePrice: 100, rule: { type: 'fixed_discount', value: 15 } }).total, 85);
  assert.equal(computePrice({ basePrice: 100, rule: { type: 'none' } }).total, 100);
  assert.equal(computePrice({ basePrice: 100, rule: null }).total, 100); // no rule → base
});

test('quantity multiplies the base before the rule (subtotal + configured fee)', () => {
  const r = computePrice({ basePrice: 50, quantity: 2, rule: { type: 'percentage_addition', value: 10 } });
  assert.equal(r.subtotal, 100);
  assert.equal(r.total, 110);
});

test('unknown base price → ok:false, never invents a number', () => {
  const r = computePrice({ basePrice: 'حسب الطلب', rule: { type: 'percentage_addition', value: 10 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_base_price');
  assert.equal(r.total, undefined);
});

test('accepts price strings for base (parses the number)', () => {
  assert.equal(computePrice({ basePrice: '99 ريال', rule: { type: 'fixed_addition', value: 1 } }).total, 100);
});

// ── buildCalculationBlock: tenant-driven prompt fact, empty when unset ─
test('buildCalculationBlock is empty when the tenant configured no rule (0 impact)', () => {
  assert.equal(buildCalculationBlock({}), '');
  assert.equal(buildCalculationBlock({ pricingRules: [] }), '');
});

test('buildCalculationBlock surfaces the tenant rule + no-escalate + one-question guidance', () => {
  const block = buildCalculationBlock({ pricingRules: [{ type: 'percentage_addition', value: 10, label: 'رسوم التقسيط' }] });
  assert.match(block, /10\s*%|10%/);
  assert.match(block, /رسوم التقسيط/);
  // Must instruct: compute from known base price, don't invent, ask ONE question
  // if the package is ambiguous, and do NOT escalate merely for a calculation.
  assert.match(block, /لا تصعّد|بدون تصعيد|لا تحوّل/);
  assert.match(block, /سؤال|وضّح|أي باقة|حدّد/);
});

test('buildCalculationBlock supports a single calculationRule object too (general)', () => {
  const block = buildCalculationBlock({ calculationRule: { type: 'fixed_addition', value: 15, label: 'رسوم توصيل' } });
  assert.match(block, /15/);
  assert.match(block, /رسوم توصيل/);
});

// ── Reference resolution + real computePrice() wiring in the reply path ──
const {
  detectPriceQuestion,
  resolveProductReference,
  resolvePriceComputation,
  buildPriceComputationBlock,
} = require('../src/services/ai/deterministic-calc');

const HIST_X = [
  { role: 'user', content: 'أبي الباقة X' },
  { role: 'assistant', content: 'تمام، الباقة X متوفرة' },
  { role: 'user', content: 'أبي أدفع بالطريقة Y' },
  { role: 'assistant', content: 'الرسوم حسب إعداد المتجر' },
];
const PRODUCTS_A = [{ name: 'الباقة X', price: '100 ريال' }, { name: 'باقة أخرى', price: '300' }];

test('detectPriceQuestion recognizes price/calc questions', () => {
  assert.equal(detectPriceQuestion('كم؟'), true);
  assert.equal(detectPriceQuestion('بكم تطلع؟'), true);
  assert.equal(detectPriceQuestion('كم المجموع'), true);
  assert.equal(detectPriceQuestion('مرحبا كيف الحال'), false);
});

test('MEMORY: "كم؟" resolves to the previously-mentioned product (الباقة X), not another', () => {
  const r = resolveProductReference({ history: HIST_X, latestUserText: 'كم؟', products: PRODUCTS_A });
  assert.equal(r.status, 'resolved');
  assert.equal(r.product.name, 'الباقة X'); // bound to the right prior product
});

test('MEMORY: two different products referenced → ambiguous (ask, do not guess)', () => {
  const hist = [{ role: 'user', content: 'أبي الباقة X' }, { role: 'user', content: 'ولا لا، باقة أخرى أحسن' }];
  const r = resolveProductReference({ history: hist, latestUserText: 'كم؟', products: PRODUCTS_A });
  assert.equal(r.status, 'ambiguous');
});

test('P2 CORE: computePrice() actually runs inside the reply-path resolver → 100 + 10% = 110', () => {
  const config = { products: PRODUCTS_A, pricingRules: [{ type: 'percentage_addition', value: 10, label: 'رسوم التقسيط' }] };
  const r = resolvePriceComputation({ history: HIST_X, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.product.name, 'الباقة X');
  // The number came OUT OF computePrice (not the prompt): it carries computePrice's
  // own breakdown fields, and equals 110.
  assert.equal(r.computation.total, 110);
  assert.equal(r.computation.subtotal, 100);
  assert.equal(r.computation.ruleType, 'percentage_addition');
});

test('P2 CORE: a different tenant computes its own number → 200 + 5% = 210', () => {
  const config = { products: [{ name: 'المنتج Z', price: '200' }], pricingRules: [{ type: 'percentage_addition', value: 5 }] };
  const hist = [{ role: 'user', content: 'أبي المنتج Z' }];
  const r = resolvePriceComputation({ history: hist, latestUserText: 'كم السعر؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.computation.total, 210);
});

test('P2: not a price question → not_a_calc (no computation)', () => {
  const r = resolvePriceComputation({ history: HIST_X, latestUserText: 'شكراً', config: { products: PRODUCTS_A } });
  assert.equal(r.status, 'not_a_calc');
});

test('P2: ambiguous product → ambiguous_product (clarify, not escalate)', () => {
  const hist = [{ role: 'user', content: 'أبي الباقة X أو باقة أخرى' }];
  const r = resolvePriceComputation({ history: hist, latestUserText: 'كم؟', config: { products: PRODUCTS_A } });
  assert.equal(r.status, 'ambiguous_product');
});

test('P2: unknown base price → unknown_base (never invents a number)', () => {
  const config = { products: [{ name: 'خدمة خاصة', price: 'حسب الطلب' }], pricingRules: [{ type: 'percentage_addition', value: 10 }] };
  const r = resolvePriceComputation({ history: [{ role: 'user', content: 'أبي خدمة خاصة' }], latestUserText: 'كم؟', config });
  assert.equal(r.status, 'unknown_base');
});

test('P2: multiple variants, none chosen → ambiguous_variant (ask one question)', () => {
  const config = { products: [{ name: 'اشتراك', variants: [{ label: 'شهر', price: '50' }, { label: 'سنة', price: '500' }] }], pricingRules: [] };
  const r = resolvePriceComputation({ history: [{ role: 'user', content: 'أبي اشتراك' }], latestUserText: 'كم؟', config });
  assert.equal(r.status, 'ambiguous_variant');
});

test('P2: variant explicitly chosen → computes from that variant price', () => {
  const config = { products: [{ name: 'اشتراك', variants: [{ label: 'شهر', price: '50' }, { label: 'سنة', price: '500' }] }], pricingRules: [{ type: 'percentage_addition', value: 10 }] };
  const hist = [{ role: 'user', content: 'أبي اشتراك سنة' }];
  const r = resolvePriceComputation({ history: hist, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.computation.total, 550); // 500 + 10%
});

test('buildPriceComputationBlock renders calculated_total as a fact; ambiguous → one question, no escalate', () => {
  const computed = buildPriceComputationBlock({ status: 'computed', product: { name: 'الباقة X' }, variant: null,
    rule: { type: 'percentage_addition', value: 10, label: 'رسوم التقسيط' },
    computation: { total: 110, subtotal: 100, basePrice: 100, ruleType: 'percentage_addition' } });
  assert.match(computed, /calculated_total=110/);
  assert.match(computed, /لا تُعِد حسابه|كما هو/);

  const amb = buildPriceComputationBlock({ status: 'ambiguous_variant', product: { name: 'اشتراك' }, variants: ['شهر', 'سنة'] });
  assert.match(amb, /سؤال|أي/);
  assert.match(amb, /لا تصعّد|لا تحوّل/);

  const unk = buildPriceComputationBlock({ status: 'unknown_base', product: { name: 'خدمة' } });
  assert.match(unk, /لا تخترع/);
});
