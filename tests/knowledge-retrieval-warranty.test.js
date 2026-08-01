'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scorePolicy, retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');

test('مضمون matches an owner policy keyed on ضمان', () => {
  const score = scorePolicy('الاشتراك مضمون؟', 'ضمان', 'نعم الاشتراك مضمون ورسمي');
  assert.ok(score >= 3, `expected >=3, got ${score}`);
});

test('documented warranty surfaces for a "مضمون" question', () => {
  const config = { autoReplyKeywords: { 'ضمان': 'نعم الاشتراك مضمون ورسمي' } };
  const { matched } = retrieveRelevantPolicies(config, 'الاشتراك مضمون؟');
  assert.ok(matched.length >= 1, 'warranty policy should be retrieved');
});

test('no warranty policy exists → nothing wrongly asserted for "الدفع مضمون؟"', () => {
  const config = { autoReplyKeywords: { 'الشحن': 'الشحن مجاني' } };
  const { matched } = retrieveRelevantPolicies(config, 'الدفع مضمون؟');
  assert.strictEqual(matched.length, 0, 'must not surface an unrelated policy');
});
