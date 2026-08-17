'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePriceComputation } = require('../src/services/ai/deterministic-calc');

// Bug 2 — genuine ambiguity must win over a single guessed context entity.
test('D: customer named two products then "كم؟" → ambiguous, even if context guessed one', () => {
  const config = { products: [{ name: 'باقة سيلفر', price: 100 }, { name: 'باقة قولد', price: 200 }] };
  const res = resolvePriceComputation({
    history: [{ role: 'user', content: 'وش الفرق بين باقة سيلفر و باقة قولد؟' }],
    latestUserText: 'كم؟',
    config,
    resolvedContext: { activeProduct: 'باقة سيلفر' }, // extractor guessed one
  });
  assert.equal(res.status, 'ambiguous_product', 'must not silently pick silver');
  assert.deepEqual(res.candidates.sort(), ['باقة سيلفر', 'باقة قولد'].sort());
});

// Bug 3 — a variant mentioned alone binds to its ONLY parent product.
test('E: only the variant named ("السنوي" after correction) → binds to its parent, prices it', () => {
  const config = { products: [{ name: 'اشتراك التصميم', price: null, variants: [{ label: 'شهري', price: 20 }, { label: 'سنوي', price: 200 }] }] };
  const res = resolvePriceComputation({
    history: [{ role: 'user', content: 'أبي الاشتراك الشهري' }, { role: 'user', content: 'لا خلاص الأفضل السنوي' }],
    latestUserText: 'طيب كم يطلع؟',
    config,
    resolvedContext: { activeProduct: 'السنوي', activeVariant: 'سنوي' }, // extractor stored the variant as the entity
  });
  assert.equal(res.status, 'computed');
  assert.equal(res.product.name, 'اشتراك التصميم');
  assert.equal(res.variant.label, 'سنوي');
  assert.equal(res.computation.total, 200);
});

test('variant shared by MORE THAN ONE product → ambiguous (no guess)', () => {
  const config = { products: [
    { name: 'منتج أ', price: null, variants: [{ label: 'سنوي', price: 100 }] },
    { name: 'منتج ب', price: null, variants: [{ label: 'سنوي', price: 300 }] },
  ] };
  const res = resolvePriceComputation({
    history: [{ role: 'user', content: 'أبي السنوي' }],
    latestUserText: 'كم؟',
    config,
    resolvedContext: {},
  });
  assert.equal(res.status, 'ambiguous_product');
});

test('variant matching NO product → no guess', () => {
  const config = { products: [{ name: 'منتج', price: null, variants: [{ label: 'سنوي', price: 100 }] }] };
  const res = resolvePriceComputation({
    history: [{ role: 'user', content: 'أبي الباقة الذهبية' }],
    latestUserText: 'كم؟',
    config,
    resolvedContext: { activeVariant: 'الذهبية' },
  });
  assert.equal(res.status, 'no_reference');
});
