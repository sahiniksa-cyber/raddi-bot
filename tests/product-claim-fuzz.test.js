'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { baseConfig } = require('../scripts/simulate-safe-replies');
const {
  buildProductFactCatalog,
  resolveProductFocus,
} = require('../src/services/products/product-facts');
const { validateCommercialClaims } = require('../src/services/ai/product-claim-validator');

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('fuzzed Adobe duration/price claims pass only for exact catalog tuples', () => {
  const random = deterministicRandom(0x5afe);
  const catalog = buildProductFactCatalog(baseConfig());
  const focus = resolveProductFocus({ catalog, customerText: 'سعر أدوبي؟' });
  const valid = new Set(['4|189', '8|319']);

  for (let index = 0; index < 500; index++) {
    const duration = 1 + Math.floor(random() * 18);
    const price = 50 + Math.floor(random() * 400);
    const punctuation = ['.', '!', '؟', '،'][Math.floor(random() * 4)];
    const name = ['أدوبي', 'Adobe', 'ادوبى'][Math.floor(random() * 3)];
    const reply = `${name} ${duration} أشهر بـ${price} ريال${punctuation}`;
    const checked = validateCommercialClaims(reply, { catalog, focus });
    assert.equal(
      checked.valid,
      valid.has(`${duration}|${price}`),
      `unexpected result for ${reply}: ${JSON.stringify(checked.issues)}`,
    );
  }
});
