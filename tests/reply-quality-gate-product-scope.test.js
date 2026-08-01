'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findUnsupportedFacts } = require('../src/services/ai/reply-quality-gate');

// Two products: Adobe has ONLY a 4-month option; Netflix has an 8-month option.
const config = {
  storeName: 'متجر برو',
  products: [
    { name: 'اشتراك ادوبي', variants: [{ label: 'اشتراك 4 اشهر', price: '189' }] },
    { name: 'اشتراك نتفلكس', variants: [{ label: 'اشتراك 8 اشهر', price: '50' }] },
  ],
};

function withScope(on, fn) {
  const prev = process.env.PRODUCT_SCOPED_GROUNDING_ENABLED;
  if (on) process.env.PRODUCT_SCOPED_GROUNDING_ENABLED = 'true';
  else delete process.env.PRODUCT_SCOPED_GROUNDING_ENABLED;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PRODUCT_SCOPED_GROUNDING_ENABLED;
    else process.env.PRODUCT_SCOPED_GROUNDING_ENABLED = prev;
  }
}

test('flag OFF → cross-product leak reproduced (Adobe borrows Netflix 8-month)', () => {
  withScope(false, () => {
    const issues = findUnsupportedFacts('متاح 4 أشهر و8 أشهر', { config, customerText: 'في اشتراك ادوبي ؟' });
    const flagged8 = issues.some(i => /8|٨/.test(i.value));
    assert.strictEqual(flagged8, false, 'global guard wrongly treats 8-month as valid for Adobe');
  });
});

test('flag ON → Adobe "8 أشهر" flagged (Netflix 8-month no longer legitimizes it)', () => {
  withScope(true, () => {
    const issues = findUnsupportedFacts('متاح 4 أشهر و8 أشهر', { config, customerText: 'في اشتراك ادوبي ؟' });
    assert.ok(issues.some(i => /8|٨/.test(i.value)), 'must flag 8 أشهر for Adobe');
  });
});

test('flag ON → Netflix "8 أشهر" NOT flagged (it genuinely has it — no over-flag)', () => {
  withScope(true, () => {
    const issues = findUnsupportedFacts('متاح 8 أشهر', { config, customerText: 'ابغى اشتراك نتفلكس' });
    assert.ok(!issues.some(i => /8|٨/.test(i.value)), 'must NOT flag a real Netflix option');
  });
});

test('flag ON → no product identified → falls back to store-wide (no over-flag)', () => {
  withScope(true, () => {
    const issues = findUnsupportedFacts('متاح 8 أشهر', { config, customerText: 'كم المدة المتاحة؟' });
    assert.ok(!issues.some(i => /8|٨/.test(i.value)), 'generic question must not over-flag');
  });
});
