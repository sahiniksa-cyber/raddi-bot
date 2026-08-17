'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateState } = require('../src/services/ai/conversation-state');
const { deriveResolvedPricingContext } = require('../src/services/ai/deterministic-calc');

// Regression (found by the long replay): last_seen markers that are numeric
// sequences must be compared NUMERICALLY, not lexicographically — otherwise
// '10' < '6' and the newest entity is chosen wrong.

test('deriveActiveEntity: multi-digit sequence markers order numerically', () => {
  const s = validateState({
    active_entities: [
      { type: 'product', ref: 'canva', label: 'كانفا', last_seen: '6' },
      { type: 'product', ref: 'adobe', label: 'أدوبي', last_seen: '10' },
    ],
  });
  assert.equal(s.active_entity.ref, 'adobe'); // turn 10 is later than turn 6
});

test('deriveResolvedPricingContext: newest product across multi-digit markers', () => {
  const s = validateState({
    active_entities: [
      { type: 'product', ref: 'canva', label: 'كانفا', last_seen: '6' },
      { type: 'subscription', ref: 'adobe', label: 'أدوبي', last_seen: '10' },
      { type: 'payment_method', ref: 'inst', label: 'تقسيط', last_seen: '25' },
    ],
  });
  const rc = deriveResolvedPricingContext(s);
  assert.equal(rc.activeProduct, 'أدوبي');
  assert.equal(rc.activePaymentMethod, 'تقسيط');
});

test('ISO-timestamp markers still order correctly (string compare is fine for those)', () => {
  const s = validateState({
    active_entities: [
      { type: 'product', ref: 'a', label: 'A', last_seen: '2026-08-16T09:00:00Z' },
      { type: 'product', ref: 'b', label: 'B', last_seen: '2026-08-16T11:00:00Z' },
    ],
  });
  assert.equal(s.active_entity.ref, 'b');
});
