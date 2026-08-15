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
