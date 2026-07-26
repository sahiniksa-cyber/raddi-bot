'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { organizeProductsForConfig } = require('../src/services/products/product-import');
const { canonicalConfig, product } = require('./helpers/canonical-config');

test('canonical product links and long descriptions remain bound to their product', () => {
  const imported = product({
    id: 'router',
    name: 'Router',
    description: 'Full product description',
    links: ['https://merchant.invalid/router'],
  });
  const result = organizeProductsForConfig(canonicalConfig(), [imported]);
  const saved = result.merchantPolicy.catalog.products[0];
  assert.equal(saved.description, imported.description);
  assert.deepEqual(saved.links, imported.links);
});
