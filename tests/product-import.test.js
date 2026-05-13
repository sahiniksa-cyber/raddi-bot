'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { organizeProductsForConfig } = require('../src/services/products/product-import');

test('organizeProductsForConfig merges imported products with existing platform products', () => {
  const result = organizeProductsForConfig(
    {
      products: [
        { name: 'Adobe كريتيف كلاود', price: '59 ريال', description: 'شهر' },
      ],
      botInstructions: '',
    },
    [
      { name: 'أدوبي كريتيف كلاود', price: '99 ريال', description: 'ثلاثة أشهر' },
      { name: 'Gemini Pro', price: '29 ريال', description: 'شهر' },
    ],
  );

  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].name, 'Adobe كريتيف كلاود');
  assert.match(result.products[0].description, /ثلاثة أشهر/);
  assert.match(result.products[1].name, /Gemini Pro/);
});

test('organizeProductsForConfig also extracts products from prompt when fields are empty', () => {
  const result = organizeProductsForConfig({
    products: [],
    botInstructions: `
### المنتجات
كانفا برو
- السعر: 12 ريال
- المدة: سنة
`,
  });

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].name, 'كانفا برو');
  assert.match(result.products[0].description, /السعر/);
});
