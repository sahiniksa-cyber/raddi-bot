'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { organizeProductsForConfig } = require('../../src/services/products/product-import');
const { canonicalConfig } = require('../helpers/canonical-config');

test('legacy-looking imported price is quarantined without catalog inference', () => {
  const result = organizeProductsForConfig(canonicalConfig(), [
    { name: 'منتج مجهول', price: '99' },
  ]);
  assert.equal(result.merchantPolicy.status, 'needs_review');
  assert.deepEqual(result.merchantPolicy.catalog.products, []);
  assert.equal(result.productImportReport.reviewItems[0].code, 'untyped_or_invalid_product');
});
