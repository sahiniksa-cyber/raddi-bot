'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAvoidedContent } = require('../lib/post-process-reply');

// Regression (found by the live run): tidyWhitespace treated a decimal point as a
// sentence period and split "207.9" → "207. 9", which then failed grounding and
// blocked the correct price from reaching the customer.
test('decimal prices are never split by post-processing', () => {
  assert.equal(stripAvoidedContent('الإجمالي 207.9 ريال', {}), 'الإجمالي 207.9 ريال');
  assert.equal(stripAvoidedContent('سعر 12.5 ريال ومدة 3.5 يوم', {}), 'سعر 12.5 ريال ومدة 3.5 يوم');
});

test('a real sentence period is still spaced normally', () => {
  assert.equal(stripAvoidedContent('مرحبا.شكرا لك', {}), 'مرحبا. شكرا لك');
});
