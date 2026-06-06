'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePromptProducts } = require('../src/services/products/product-knowledge');

const PROMPT = `انت موظف لطيف.

## المنتجات
اشتراك 4 أشهر
120 ريال
اشتراك سنة
350 ريال`;

test('digit-named product ("4 أشهر") is NOT dropped from prompt products', () => {
  const products = parsePromptProducts(PROMPT);
  const names = products.map(p => p.name);
  assert.ok(names.includes('اشتراك 4 أشهر'), `expected "اشتراك 4 أشهر" in ${JSON.stringify(names)}`);
  assert.ok(names.includes('اشتراك سنة'));
});

test('price line is captured as price, not treated as a product name', () => {
  const products = parsePromptProducts(PROMPT);
  const sub = products.find(p => p.name === 'اشتراك 4 أشهر');
  assert.equal(sub.price, '120 ريال');
  // "120 ريال" must NOT appear as its own product name
  assert.ok(!products.some(p => p.name === '120 ريال'));
});

test('product with only name+price (no description) is kept', () => {
  const products = parsePromptProducts(`## المنتجات\nاشتراك 4 أشهر\n120 ريال`);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'اشتراك 4 أشهر');
  assert.equal(products[0].price, '120 ريال');
});

const { buildRelevantProductContext, findRelevantProducts } = require('../src/services/products/product-knowledge');

test('customer asking about "4 اشهر" finds the digit-named product', () => {
  const config = { products: [], botInstructions: `## المنتجات\nاشتراك 4 أشهر\n120 ريال\nاشتراك سنة\n350 ريال` };
  const found = findRelevantProducts(config, 'عندكم اشتراك 4 اشهر؟');
  assert.ok(found.some(p => p.name === 'اشتراك 4 أشهر'), `got ${JSON.stringify(found.map(p=>p.name))}`);
  const ctx = buildRelevantProductContext({ config, customerText: 'عندكم اشتراك 4 اشهر؟' });
  assert.match(ctx, /4 أشهر/);
  assert.match(ctx, /120/);
});
