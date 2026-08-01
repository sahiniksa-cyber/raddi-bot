'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tokenize } = require('../src/services/ai/knowledge-retrieval');

test('question mark is a delimiter, not part of the word', () => {
  assert.deepStrictEqual(tokenize('مضمون؟'), ['مضمون']);
});
test('arabic comma is a delimiter', () => {
  assert.deepStrictEqual(tokenize('ضمان، نعم'), ['ضمان', 'نعم']);
});
