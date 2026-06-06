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
