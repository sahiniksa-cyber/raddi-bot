'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { organizeProductsForConfig } = require('../src/services/products/product-import');
const { canonicalConfig, product } = require('./helpers/canonical-config');

test('canonical import preserves validated variants exactly', () => {
  const imported = product({
    id: 'subscription',
    name: 'اشتراك',
    variants: [{
      id: 'subscription-year',
      name: 'سنة',
      price: { amountMinor: 35000, currency: 'SAR' },
      duration: '12 months',
    }],
  });
  const result = organizeProductsForConfig(canonicalConfig(), [imported]);
  assert.deepEqual(result.merchantPolicy.catalog.products[0].variants, imported.variants);
});

test('canonical prompt renders product-bound variant evidence', () => {
  const config = canonicalConfig({
    products: [product({
      id: 'subscription',
      name: 'اشتراك',
      variants: [{
        id: 'subscription-year',
        name: 'سنة',
        price: { amountMinor: 35000, currency: 'SAR' },
        duration: '12 months',
      }],
    })],
  });
  const ai = new AIClient(config, { info() {}, warn() {}, error() {} }, { record() {} });
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'كم سعر اشتراك سنة؟' }]);
  assert.match(prompt, /\[subscription-year\]/);
  assert.match(prompt, /350\.00 SAR/);
  assert.match(prompt, /12 months/);
});

test('invalid variant data is marked for review rather than normalized heuristically', () => {
  const result = organizeProductsForConfig(canonicalConfig(), [{
    id: 'legacy',
    name: 'Legacy',
    aliases: [],
    description: '',
    links: [],
    attributes: {},
    variants: [{ label: 'سنة', price: '350' }],
  }]);
  assert.equal(result.merchantPolicy.status, 'needs_review');
  assert.equal(result.merchantPolicy.catalog.products.length, 0);
});
