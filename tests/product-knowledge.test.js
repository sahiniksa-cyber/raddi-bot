'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProductCatalog,
  buildRelevantProductContext,
  normalizeProductText,
} = require('../src/services/products/product-knowledge');

const instructions = `
## المنتجات والأسعار

أدوبي كريتيف كلاود
شهر — 59 ريال — دعوة على إيميلك
4 أشهر — 169 ريال — حساب جاهز إيميل وباسورد
6 أشهر — 269 ريال — إيميل جديد ما له علاقة بـ Adobe
12 شهر — 379 ريال — إيميل جديد ما له علاقة بـ Adobe

جيميني برو
شهر — 24 ريال
12 شهر — 99 ريال

مايكروسوفت أوفيس مدى الحياة
39 ريال — حساب خاص إيميل وباسورد

## ممنوع
معلومات عن منتجات خارج المتجر — ممنوع
`;

test('buildProductCatalog extracts products from owner prompt sections', () => {
  const catalog = buildProductCatalog({ botInstructions: instructions, products: [] });

  assert.equal(catalog.length, 3);
  assert.equal(catalog[0].name, 'أدوبي كريتيف كلاود');
  assert.match(catalog[0].description, /4 أشهر/);
  assert.equal(catalog[0].source, 'prompt');
});

test('buildProductCatalog merges structured products with prompt products', () => {
  const catalog = buildProductCatalog({
    products: [{ name: 'كانفا برو', price: '9 ريال', description: 'سنة' }],
    botInstructions: instructions,
  });

  assert.ok(catalog.some(product => product.name === 'كانفا برو'));
  assert.ok(catalog.some(product => product.name === 'أدوبي كريتيف كلاود'));
});

test('buildRelevantProductContext returns matching product details for customer question', () => {
  const context = buildRelevantProductContext({
    config: { botInstructions: instructions, products: [] },
    customerText: 'كم سعر ادوبي شهر؟',
  });

  assert.match(context, /أدوبي كريتيف كلاود/);
  assert.match(context, /59 ريال/);
  assert.doesNotMatch(context, /جيميني برو/);
  assert.doesNotMatch(context, /غير متوفر/);
});

test('normalizeProductText handles Arabic and English variants', () => {
  assert.equal(normalizeProductText('Adobe كريتيف كلاود'), normalizeProductText('ادوبى كريتيف كلاود'));
});
