'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProductCatalog,
  buildRelevantProductContext,
} = require('../src/services/products/product-knowledge');
const { mergeImportedProducts } = require('../src/services/products/product-import');
const { canonicalConfig, product } = require('./helpers/canonical-config');

function linkedConfig() {
  return canonicalConfig({
    products: [product({
      name: 'أدوبي',
      description: 'اشتراك سنوي كامل لكل برامج أدوبي ويشمل فوتوشوب',
      links: ['https://shop.example/adobe'],
      variants: [{
        name: 'سنوي',
        price: { amountMinor: 9900, currency: 'SAR' },
      }],
    })],
  });
}

test('catalog preserves canonical links and description', () => {
  const item = buildProductCatalog(linkedConfig())[0];
  assert.equal(item.url, 'https://shop.example/adobe');
  assert.equal(item.description, 'اشتراك سنوي كامل لكل برامج أدوبي ويشمل فوتوشوب');
});

test('AI product context includes canonical description and link', () => {
  const context = buildRelevantProductContext({
    config: linkedConfig(),
    customerText: 'أبي اشتراك أدوبي',
  });
  assert.match(context, /اشتراك سنوي كامل/);
  assert.match(context, /https:\/\/shop\.example\/adobe/);
});

test('canonical description widens product matching', () => {
  const context = buildRelevantProductContext({
    config: linkedConfig(),
    customerText: 'عندكم فوتوشوب؟',
  });
  assert.match(context, /أدوبي/);
});

test('legacy importer normalizes url and long-description aliases for explicit migration review', () => {
  const merged = mergeImportedProducts([], [
    { name: 'كانفا', price: '50', link: 'https://x.co/canva', long_description: 'وصف طويل لكانفا' },
  ]);
  const item = merged.find(entry => entry.name === 'كانفا');
  assert.equal(item.url, 'https://x.co/canva');
  assert.equal(item.longDescription, 'وصف طويل لكانفا');
});

test('legacy products cannot silently become runtime product knowledge', () => {
  assert.throws(
    () => buildRelevantProductContext({
      config: { products: [{ name: 'جيميني', price: '40 ريال' }] },
      customerText: 'جيميني',
    }),
    /MERCHANT_POLICY_MISSING/,
  );
});
