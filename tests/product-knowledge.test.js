'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProductCatalog,
  buildRelevantProductContext,
  normalizeProductText,
} = require('../src/services/products/product-knowledge');
const { canonicalConfig, product } = require('./helpers/canonical-config');

function config() {
  return canonicalConfig({
    products: [
      product({
        id: 'adobe',
        name: 'أدوبي كريتيف كلاود',
        aliases: ['Adobe'],
        description: 'كل برامج أدوبي',
        links: ['https://shop.example/adobe'],
        variants: [{
          name: 'شهر',
          price: { amountMinor: 5900, currency: 'SAR' },
        }],
      }),
      product({
        id: 'gemini',
        name: 'جيميني برو',
        variants: [{
          name: 'سنة',
          price: { amountMinor: 9900, currency: 'SAR' },
        }],
      }),
    ],
  });
}

test('buildProductCatalog reads only canonical policy products and exact prices', () => {
  const catalog = buildProductCatalog({
    ...config(),
    products: [{ name: 'LEGACY', price: '999 SAR' }],
  });
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].name, 'أدوبي كريتيف كلاود');
  assert.equal(catalog[0].price, '59.00 SAR');
  assert.equal(catalog.some(item => item.name === 'LEGACY'), false);
});

test('buildRelevantProductContext selects the canonical matching product', () => {
  const context = buildRelevantProductContext({
    config: config(),
    customerText: 'كم سعر Adobe شهر؟',
  });
  assert.match(context, /أدوبي كريتيف كلاود/);
  assert.match(context, /59\.00 SAR/);
  assert.doesNotMatch(context, /جيميني برو/);
});

test('missing merchantPolicy fails closed instead of parsing prose', () => {
  assert.throws(
    () => buildProductCatalog({
      products: [{ name: 'Legacy', price: '999' }],
      botInstructions: 'Legacy product 999 SAR',
    }),
    /MERCHANT_POLICY_MISSING/,
  );
});

test('normalizeProductText handles Arabic and English variants', () => {
  assert.equal(normalizeProductText('Adobe كريتيف كلاود'), normalizeProductText('ادوبى كريتيف كلاود'));
});
