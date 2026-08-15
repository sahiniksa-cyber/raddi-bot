'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPricingRulesFromInstructions,
  resolvePricingRules,
  resolveProductReference,
  resolvePriceComputation,
} = require('../src/services/ai/deterministic-calc');

// ── P2-A: legacy merchant instructions → structured pricing rules ─────
test('extracts a percentage-addition fee tied to a payment method (no hardcoded names)', () => {
  const rules = extractPricingRulesFromInstructions('طريقة الدفع Y عليها رسوم 10%');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].type, 'percentage_addition');
  assert.equal(rules[0].value, 10);
  assert.equal(rules[0].trigger, 'Y');
  assert.equal(rules[0].source, 'merchant_instruction');
});

test('extracts discount / fixed / "عند الدفع بـ" forms generically', () => {
  assert.deepEqual(
    extractPricingRulesFromInstructions('خصم 15% عند Q').map(r => [r.type, r.value, r.trigger]),
    [['percentage_discount', 15, 'Q']],
  );
  assert.deepEqual(
    extractPricingRulesFromInstructions('رسوم ثابتة 20 عند Z').map(r => [r.type, r.value, r.trigger]),
    [['fixed_addition', 20, 'Z']],
  );
  assert.deepEqual(
    extractPricingRulesFromInstructions('عند الدفع بـ X أضف 5%').map(r => [r.type, r.value, r.trigger]),
    [['percentage_addition', 5, 'X']],
  );
});

test('does NOT extract a rule from vague/ambiguous text (no invented numbers)', () => {
  assert.deepEqual(extractPricingRulesFromInstructions('الأسعار تختلف حسب الطلب'), []);
  assert.deepEqual(extractPricingRulesFromInstructions('نوصل لكل مدن المملكة'), []);
  assert.deepEqual(extractPricingRulesFromInstructions(''), []);
});

test('resolvePricingRules: structured rules WIN over legacy for the same trigger', () => {
  const config = {
    pricingRules: [{ type: 'percentage_addition', value: 12, trigger: 'Y' }],
    botInstructions: 'طريقة الدفع Y عليها رسوم 10%',
  };
  const rules = resolvePricingRules(config);
  const y = rules.filter(r => r.trigger === 'Y');
  assert.equal(y.length, 1, 'no duplicate for the same trigger');
  assert.equal(y[0].value, 12, 'structured value wins');
  assert.equal(y[0].source, 'structured');
});

test('resolvePricingRules: legacy used only when no structured rule exists', () => {
  const rules = resolvePricingRules({ botInstructions: 'خصم 15% عند Q' });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, 'merchant_instruction');
});

// ── P2-C: latest active product (walk newest→oldest, customer messages) ─
const PRODUCTS = [{ name: 'المنتج A', price: '100' }, { name: 'المنتج B', price: '300' }];

test('latest customer product wins after a switch A → B', () => {
  const history = [
    { role: 'user', content: 'كم المنتج A؟' },
    { role: 'assistant', content: 'المنتج A بـ 100' },
    { role: 'user', content: 'خلاص أبي المنتج B' },
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolveProductReference({ history, latestUserText: 'كم؟', products: PRODUCTS });
  assert.equal(r.status, 'resolved');
  assert.equal(r.product.name, 'المنتج B'); // NOT ambiguous A/B
});

test('only the SAME latest message containing "A أو B" is ambiguous', () => {
  const history = [{ role: 'user', content: 'المنتج A أو المنتج B؟' }, { role: 'user', content: 'كم؟' }];
  const r = resolveProductReference({ history, latestUserText: 'كم؟', products: PRODUCTS });
  assert.equal(r.status, 'ambiguous');
});

test('a bot message repeating a product name does NOT change the active product', () => {
  const history = [
    { role: 'user', content: 'أبي المنتج A' },
    { role: 'assistant', content: 'عندنا أيضاً المنتج B ممتاز' }, // bot mentions B
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolveProductReference({ history, latestUserText: 'كم؟', products: PRODUCTS });
  assert.equal(r.status, 'resolved');
  assert.equal(r.product.name, 'المنتج A'); // customer's product stays active
});

// ── P2 end-to-end via the LEGACY botInstructions path (the real merchant case) ─
test('LEGACY path: botInstructions fee + product 100 + pay Y → computePrice → 110', () => {
  const config = { products: [{ name: 'X', price: '100' }], botInstructions: 'طريقة الدفع Y عليها رسوم 10%' };
  const history = [
    { role: 'user', content: 'أبي X' },
    { role: 'user', content: 'أبي أدفع Y' },
    { role: 'user', content: 'كم؟' },
  ];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.product.name, 'X');
  assert.equal(r.rule.trigger, 'Y');
  assert.equal(r.rule.source, 'merchant_instruction');
  assert.equal(r.computation.total, 110);
});

test('second tenant, different legacy rule → 200 + 5% = 210 (no leak from tenant 1)', () => {
  const config = { products: [{ name: 'Z', price: '200' }], botInstructions: 'عند الدفع بـ Q أضف 5%' };
  const history = [{ role: 'user', content: 'أبي Z' }, { role: 'user', content: 'أدفع Q' }, { role: 'user', content: 'كم؟' }];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.computation.total, 210);
});

test('multiple payment methods, none chosen → ambiguous_rule (ask, do not escalate/guess)', () => {
  const config = {
    products: [{ name: 'X', price: '100' }],
    botInstructions: 'طريقة الدفع Y عليها رسوم 10%\nطريقة الدفع Q عليها رسوم 5%',
  };
  // customer expresses payment intent but doesn't name the method
  const history = [{ role: 'user', content: 'أبي X' }, { role: 'user', content: 'أبي أدفع' }, { role: 'user', content: 'كم؟' }];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'ambiguous_rule');
});

test('no fee rule at all → base price used (no fee invented)', () => {
  const config = { products: [{ name: 'X', price: '100' }] };
  const history = [{ role: 'user', content: 'أبي X' }, { role: 'user', content: 'كم؟' }];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'computed');
  assert.equal(r.computation.total, 100);
});

test('variants (monthly/yearly) not chosen → clarification, not a guess/escalation', () => {
  const config = { products: [{ name: 'اشتراك', variants: [{ label: 'شهري', price: '50' }, { label: 'سنوي', price: '500' }] }] };
  const history = [{ role: 'user', content: 'أبي اشتراك' }, { role: 'user', content: 'كم؟' }];
  const r = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.equal(r.status, 'ambiguous_variant');
});
