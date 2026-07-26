'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { organizeProductsForConfig } = require('../src/services/products/product-import');
const { canonicalConfig, product } = require('./helpers/canonical-config');

test('typed product import writes only merchantPolicy and derives a new version', () => {
  const config = canonicalConfig({
    products: [product({ id: 'existing', name: 'Existing' })],
  });
  const before = config.merchantPolicy.policyVersion;
  const result = organizeProductsForConfig(config, [
    product({ id: 'new', name: 'New product' }),
  ]);
  assert.deepEqual(
    result.merchantPolicy.catalog.products.map(entry => entry.id),
    ['existing', 'new'],
  );
  assert.notEqual(result.merchantPolicy.policyVersion, before);
  assert.equal(result.products, undefined);
});

test('untyped external product is quarantined and never inferred', () => {
  const result = organizeProductsForConfig(canonicalConfig(), [
    { name: 'Legacy product', price: '99' },
  ]);
  assert.equal(result.merchantPolicy.status, 'needs_review');
  assert.equal(result.merchantPolicy.catalog.products.length, 0);
  assert.equal(result.productImportReport.reviewItems.length, 1);
});

test('product import fails closed without an active canonical policy', () => {
  assert.throws(
    () => organizeProductsForConfig({ products: [] }, []),
    error => error.code === 'POLICY_INVALID',
  );
});
