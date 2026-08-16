'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveResolvedPricingContext, resolvePriceComputation,
} = require('../src/services/ai/deterministic-calc');
const { validateState } = require('../src/services/ai/conversation-state');

// Context Engine → deterministic pricing bridge (spec §15/§16). The engine
// RESOLVES which product/variant/payment-method; the calc still pulls the TRUSTED
// base price from config and does the arithmetic (authority order §10).

test('deriveResolvedPricingContext maps active_entities to {product,variant,paymentMethod}', () => {
  const state = validateState({
    active_entities: [
      { type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe', last_seen: '3' },
      { type: 'payment_method', ref: 'tamara', label: 'تمارا', last_seen: '7' },
      { type: 'variant', ref: 'yearly', label: 'سنوي', last_seen: '5' },
    ],
  });
  const rc = deriveResolvedPricingContext(state);
  assert.equal(rc.activeProduct, 'اشتراك Adobe');
  assert.equal(rc.activePaymentMethod, 'تمارا');
  assert.equal(rc.activeVariant, 'سنوي');
});

test('newest payment_method entity wins (customer correction persists in context)', () => {
  const state = validateState({
    active_entities: [
      { type: 'payment_method', ref: 'x', label: 'طريقة X', last_seen: '2' },
      { type: 'payment_method', ref: 'y', label: 'طريقة Y', last_seen: '9' },
    ],
  });
  assert.equal(deriveResolvedPricingContext(state).activePaymentMethod, 'طريقة Y');
});

test('Test I: bare payment method resolved in context → "كم؟" computes the exact total (189 +10% = 207.9)', () => {
  const config = {
    products: [{ name: 'اشتراك Adobe', price: 189 }],
    pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تمارا', label: 'تمارا' }],
  };
  // The customer never re-typed the product name at "كم؟"; the bot named it and
  // the customer answered the payment method with a bare word — both live in the
  // resolved context, not necessarily in the raw customer text.
  const resolvedContext = { activeProduct: 'اشتراك Adobe', activePaymentMethod: 'تمارا' };
  const history = [
    { role: 'user', content: 'أبي اشتراك Adobe' },
    { role: 'assistant', content: 'تمام، كيف تحب تدفع؟' },
    { role: 'user', content: 'تمارا' },
  ];
  const res = resolvePriceComputation({ history, latestUserText: 'كم؟', config, resolvedContext });
  assert.equal(res.status, 'computed');
  assert.equal(res.computation.total, 207.9);
  assert.equal(res.rule.trigger, 'تمارا');
});

test('resolved context does NOT override the trusted base price — config price is authoritative (§10)', () => {
  const config = { products: [{ name: 'اشتراك Adobe', price: 189 }] };
  // Even if some upstream tried to smuggle a price via the label, the engine reads
  // the base price from config, never from the context string.
  const rc = { activeProduct: 'اشتراك Adobe سعر 9999' };
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم سعره؟', config, resolvedContext: rc });
  assert.equal(res.status, 'computed');
  assert.equal(res.computation.basePrice, 189);
  assert.equal(res.computation.total, 189);
});

test('resolved product not in config → does NOT invent; falls back to regex/none', () => {
  const config = { products: [{ name: 'منتج حقيقي', price: 50 }] };
  const rc = { activeProduct: 'منتج وهمي غير موجود' };
  const res = resolvePriceComputation({ history: [], latestUserText: 'كم؟', config, resolvedContext: rc });
  assert.equal(res.status, 'no_reference');
});

test('no resolvedContext → behaviour is unchanged (backward compatible)', () => {
  const config = {
    products: [{ name: 'اشتراك Adobe', price: 189 }],
    pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تمارا', label: 'تمارا' }],
  };
  const history = [{ role: 'user', content: 'أبي اشتراك Adobe أدفع تمارا' }];
  const withCtx = resolvePriceComputation({ history, latestUserText: 'كم؟', config, resolvedContext: null });
  const legacy = resolvePriceComputation({ history, latestUserText: 'كم؟', config });
  assert.deepEqual(withCtx, legacy);
  assert.equal(legacy.computation.total, 207.9);
});
