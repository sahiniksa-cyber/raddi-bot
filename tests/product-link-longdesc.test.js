'use strict';

// Adds two product fields end-to-end: `url` (product link) and `longDescription`.
// Verifies they survive the catalog, are injected into the AI product context,
// are picked up by the importer (incl. common column aliases), and are preserved
// when organizing imported products back into config.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProductCatalog, buildRelevantProductContext } = require('../src/services/products/product-knowledge');
const { mergeImportedProducts, organizeProductsForConfig } = require('../src/services/products/product-import');

test('catalog preserves url and longDescription from config products', () => {
  const catalog = buildProductCatalog({
    products: [{
      name: 'أدوبي',
      price: '99 ريال',
      description: 'اشتراك',
      longDescription: 'اشتراك سنوي كامل لكل برامج أدوبي',
      url: 'https://shop.example/adobe',
    }],
  });
  const p = catalog.find(x => x.name === 'أدوبي');
  assert.equal(p.url, 'https://shop.example/adobe');
  assert.equal(p.longDescription, 'اشتراك سنوي كامل لكل برامج أدوبي');
});

test('AI product context includes the long description and the link', () => {
  const ctx = buildRelevantProductContext({
    config: { products: [{ name: 'أدوبي', price: '99 ريال', longDescription: 'كل برامج أدوبي باشتراك واحد', url: 'https://x.co/a' }] },
    customerText: 'أبي اشتراك أدوبي',
  });
  assert.match(ctx, /كل برامج أدوبي باشتراك واحد/, 'long description must reach the prompt');
  assert.match(ctx, /https:\/\/x\.co\/a/, 'product link must reach the prompt');
});

test('long description widens product matching', () => {
  // Customer uses a word that only appears in the long description.
  const ctx = buildRelevantProductContext({
    config: { products: [{ name: 'أدوبي', price: '99', longDescription: 'يشمل فوتوشوب وإليستريتور وبريمير' }] },
    customerText: 'عندكم فوتوشوب؟',
  });
  assert.match(ctx, /أدوبي/, 'matched via a term found only in the long description');
});

test('importer normalizes url/link and long-description aliases', () => {
  const merged = mergeImportedProducts([], [
    { name: 'كانفا', price: '50', link: 'https://x.co/canva', long_description: 'وصف طويل لكانفا' },
  ]);
  const p = merged.find(x => x.name === 'كانفا');
  assert.equal(p.url, 'https://x.co/canva');
  assert.equal(p.longDescription, 'وصف طويل لكانفا');
});

test('organizeProductsForConfig keeps url and longDescription', () => {
  const cfg = organizeProductsForConfig({ products: [] }, [
    { name: 'اوفيس', price: '120', url: 'https://x.co/office', longDescription: 'أوفيس 365 كامل' },
  ]);
  const p = cfg.products.find(x => x.name === 'اوفيس');
  assert.equal(p.url, 'https://x.co/office');
  assert.equal(p.longDescription, 'أوفيس 365 كامل');
});

test('products without the new fields still work (no url/longDescription keys leak as empty noise)', () => {
  const ctx = buildRelevantProductContext({
    config: { products: [{ name: 'جيميني', price: '40 ريال', description: 'اشتراك شهري' }] },
    customerText: 'جيميني',
  });
  assert.match(ctx, /جيميني/);
  assert.doesNotMatch(ctx, /الرابط:/, 'no link line when url is absent');
});
