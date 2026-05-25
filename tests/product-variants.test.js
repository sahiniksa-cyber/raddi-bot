'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeImportedProducts, organizeProductsForConfig } = require('../src/services/products/product-import');
const AIClient = require('../lib/ai-client');

function makePromptClient(products) {
  return new AIClient(
    { products, model: 'google/gemini-2.0-flash', googleApiKey: 'AIzaSyDummyKeyForTesting1234' },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {}, save: () => {} },
  );
}

test('mergeImportedProducts preserves variants array on imported product', () => {
  const result = mergeImportedProducts([], [
    { name: 'أدوبي', variants: [{ label: 'شهر', price: '99 ريال' }] },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99 ريال' }]);
});

test('mergeImportedProducts filters out empty variants {label:"",price:""}', () => {
  const result = mergeImportedProducts([], [
    { name: 'أدوبي', variants: [{ label: '', price: '' }, { label: 'شهر', price: '99' }] },
  ]);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99' }]);
});

test('mergeImportedProducts does not set variants field when none provided', () => {
  const result = mergeImportedProducts([], [{ name: 'تيشيرت', price: '50 ريال' }]);
  assert.equal(result[0].variants, undefined);
});

test('mergeImportedProducts keeps variants from existing product when imported has none', () => {
  const existing = [{ name: 'أدوبي', variants: [{ label: 'شهر', price: '99' }] }];
  const imported = [{ name: 'أدوبي', description: 'وصف جديد' }];
  const result = mergeImportedProducts(existing, imported);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99' }]);
});

test('organizeProductsForConfig keeps variants on products', () => {
  const out = organizeProductsForConfig({}, [
    { name: 'عطر', variants: [{ label: '30 مل', price: '200 ريال' }] },
  ]);
  assert.deepEqual(out.products[0].variants, [{ label: '30 مل', price: '200 ريال' }]);
});

test('organizeProductsForConfig omits variants on products without them', () => {
  const out = organizeProductsForConfig({}, [{ name: 'كتاب', price: '40 ريال' }]);
  assert.equal(out.products[0].variants, undefined);
});

test('AI productsBlock renders variants as sub-bullets', () => {
  const ai = makePromptClient([
    { name: 'أدوبي', description: 'كل التطبيقات', variants: [
      { label: 'شهر', price: '99 ريال' },
      { label: 'سنة', price: '999 ريال' },
    ]},
  ]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /1\. أدوبي/);
  assert.match(prompt, /• شهر: 99 ريال/);
  assert.match(prompt, /• سنة: 999 ريال/);
});

test('AI productsBlock works unchanged when variants is absent', () => {
  const ai = makePromptClient([{ name: 'كتاب', price: '40 ريال' }]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /1\. كتاب — 40 ريال/);
  assert.doesNotMatch(prompt, /•/);
});

test('AI productsBlock skips fully-empty variants and keeps the rest', () => {
  const ai = makePromptClient([{
    name: 'عطر',
    variants: [
      { label: '', price: '' },
      { label: '30 مل', price: '200 ريال' },
    ],
  }]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /• 30 مل: 200 ريال/);
  assert.doesNotMatch(prompt, /• —:/);
});
