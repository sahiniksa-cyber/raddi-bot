'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPricingRulesFromInstructions,
  parseAmount,
  computePrice,
  resolvePriceComputation,
  resolveProductReference,
} = require('../src/services/ai/deterministic-calc');

// ── 1) REAL merchant phrasing (no hardcoded "تمارا") ──────────────────
const REAL = `اعطيني رقم الجوال اللي حاب يجي عليه طلب الدفع
وللعلم السعر يزيد 10% رسوم تمارا
اذا قالك كم احسب سعر الاشتراك وزيد عليه 10%`;

test('extracts the fee from the real merchant text: "رسوم <method>" form', () => {
  const rules = extractPricingRulesFromInstructions(REAL);
  const tamara = rules.find(r => r.trigger === 'تمارا');
  assert.ok(tamara, 'a rule triggered by the payment method must be extracted');
  assert.equal(tamara.type, 'percentage_addition');
  assert.equal(tamara.value, 10);
});

test('general trigger forms all resolve the payment method (no hardcoded names)', () => {
  const forms = {
    'رسوم X 10%': 'X',
    'X عليه رسوم 10%': 'X',
    'السعر يزيد 10% مع X': 'X',
    'عند الدفع بـ X يزيد 10%': 'X',
  };
  for (const [line, trigger] of Object.entries(forms)) {
    const r = extractPricingRulesFromInstructions(line);
    assert.equal(r.length, 1, `should extract from: ${line}`);
    assert.equal(r[0].trigger, trigger, `trigger for: ${line}`);
    assert.equal(r[0].type, 'percentage_addition');
    assert.equal(r[0].value, 10);
  }
});

test('multi-word payment method name is captured', () => {
  const r = extractPricingRulesFromInstructions('رسوم الدفع الآجل 10%');
  assert.equal(r.length, 1);
  assert.equal(r[0].trigger, 'الدفع الآجل');
});

test('MANDATORY end-to-end: real text + product 100 + pay تمارا → calculated_total = 110', () => {
  const config = { products: [{ name: 'المنتج', price: '100' }], botInstructions: REAL };
  const history = [
    { role: 'user', content: 'أبي المنتج' },
    { role: 'user', content: 'أبي أدفع تمارا' },
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.rule.trigger, 'تمارا');
  assert.equal(r.rule.source, 'merchant_instruction');
  assert.equal(r.computation.total, 110);
});

// ── 2) LATEST context for variant + payment rule ─────────────────────
test('latest variant wins: monthly then yearly → yearly', () => {
  const config = { products: [{ name: 'اشتراك', variants: [{ label: 'شهري', price: '50' }, { label: 'سنوي', price: '500' }] }] };
  const history = [
    { role: 'user', content: 'أبي اشتراك شهري' },
    { role: 'user', content: 'لا خله سنوي' },
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.variant.label, 'سنوي');
  assert.equal(r.computation.total, 500);
});

test('latest payment rule wins: pay X then switch to Y → Y rule', () => {
  const config = {
    products: [{ name: 'المنتج', price: '100' }],
    botInstructions: 'رسوم X 20%\nرسوم Y 10%',
  };
  const history = [
    { role: 'user', content: 'أبي المنتج' },
    { role: 'user', content: 'أدفع X' },
    { role: 'user', content: 'لا غيرت رأيي أدفع Y' },
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.rule.trigger, 'Y');
  assert.equal(r.computation.total, 110); // 100 + 10% (Y), not +20% (X)
});

// ── 4) Arabic numerals + Arabic percent sign ٪ ───────────────────────
test('parseAmount handles Arabic-Indic digits and prices', () => {
  assert.equal(parseAmount('١٠٠'), 100);
  assert.equal(parseAmount('١٢٥٠ ريال'), 1250);
});

test('extraction handles Arabic digits and the ٪ sign', () => {
  const r = extractPricingRulesFromInstructions('رسوم X ١٠٪');
  assert.equal(r.length, 1);
  assert.equal(r[0].value, 10);
  assert.equal(r[0].trigger, 'X');
});

test('computePrice with an Arabic-numeral base price', () => {
  const r = computePrice({ basePrice: '١٠٠ ريال', rule: { type: 'percentage_addition', value: 10 } });
  assert.equal(r.total, 110);
});
