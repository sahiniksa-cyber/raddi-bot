'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyProductOp,
  applyInstantReplyOp,
  applyDoNotReplyOp,
} = require('../lib/config-edit-appliers');

const PRODUCTS = [
  { name: 'اشتراك أدوبي', price: '80' },
  { name: 'كانفا برو', price: '40', description: 'تصميم' },
];

test('applyProductOp add appends a new product (name required)', () => {
  const r = applyProductOp(PRODUCTS, { action: 'add', product: { name: 'أوفيس', price: '30' } });
  assert.equal(r.value.length, 3);
  assert.deepEqual(r.value[2], { name: 'أوفيس', price: '30' });
  assert.equal(applyProductOp(PRODUCTS, { action: 'add', product: { name: '' } }).error !== undefined, true);
});

test('applyProductOp update merges only provided fields, keeps the rest', () => {
  const r = applyProductOp(PRODUCTS, { action: 'update', product: { name: 'كانفا برو', price: '55' } });
  const canva = r.value.find((p) => p.name === 'كانفا برو');
  assert.equal(canva.price, '55', 'price updated');
  assert.equal(canva.description, 'تصميم', 'other fields preserved');
});

test('applyProductOp update/delete on a missing product asks for clarification', () => {
  assert.ok(applyProductOp(PRODUCTS, { action: 'update', product: { name: 'منتج وهمي', price: '9' } }).needsClarify);
  assert.ok(applyProductOp(PRODUCTS, { action: 'delete', product: { name: 'منتج وهمي' } }).needsClarify);
});

test('applyProductOp delete removes the matched product', () => {
  const r = applyProductOp(PRODUCTS, { action: 'delete', product: { name: 'اشتراك أدوبي' } });
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].name, 'كانفا برو');
});

test('applyProductOp update replaces variants when provided', () => {
  const r = applyProductOp(PRODUCTS, { action: 'update', product: { name: 'اشتراك أدوبي', variants: [{ label: 'شهر', price: '30' }, { label: 'سنة', price: '250' }] } });
  const adobe = r.value.find((p) => p.name === 'اشتراك أدوبي');
  assert.equal(adobe.variants.length, 2);
  assert.equal(adobe.variants[1].price, '250');
});

test('applyInstantReplyOp add/update sets the key; delete removes it', () => {
  const add = applyInstantReplyOp({}, { action: 'add', keyword: 'الدوام', reply: 'من ٩ لـ٩' });
  assert.equal(add.value['الدوام'], 'من ٩ لـ٩');
  const del = applyInstantReplyOp({ 'الدوام': 'x' }, { action: 'delete', keyword: 'الدوام' });
  assert.equal(del.value['الدوام'], undefined);
  assert.ok(applyInstantReplyOp({}, { action: 'add', keyword: 'x', reply: '' }).error);
  assert.ok(applyInstantReplyOp({}, { action: 'delete', keyword: 'مو موجود' }).needsClarify);
});

test('applyDoNotReplyOp add normalizes + dedupes; delete removes by normalized number', () => {
  const add = applyDoNotReplyOp([], { action: 'add', number: '0501234567', name: 'مزعج' });
  assert.equal(add.value.length, 1);
  assert.equal(add.value[0].number, '0501234567');
  const dup = applyDoNotReplyOp(add.value, { action: 'add', number: '+966501234567' });
  assert.equal(dup.value.length, 1);
  const del = applyDoNotReplyOp(add.value, { action: 'delete', number: '966501234567' });
  assert.equal(del.value.length, 0);
  assert.ok(applyDoNotReplyOp([], { action: 'add', number: 'abc' }).error);
  assert.ok(applyDoNotReplyOp([], { action: 'delete', number: '0509999999' }).needsClarify);
});
