'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, scorePolicy } = require('../src/services/ai/knowledge-retrieval');

test('tokenize normalizes arabic and drops stopwords + short tokens', () => {
  const t = tokenize('متى يوصلني الطلب في الرياض؟');
  assert.ok(t.includes('يوصلني'));
  assert.ok(t.includes('الطلب') || t.includes('طلب'));
  assert.ok(!t.includes('في'));      // stopword
});

test('scorePolicy gives high score when synonym of keyword appears', () => {
  // التاجر كتب المفتاح "الشحن"؛ العميل قال "يوصلني" (مرادف)
  const score = scorePolicy('متى يوصلني الطلب؟', 'الشحن', 'الشحن مجاني ويوصل خلال 2-4 أيام عبر سمسا');
  assert.ok(score >= 3, `expected >=3 got ${score}`);
});

test('scorePolicy is ~0 for unrelated question', () => {
  const score = scorePolicy('عندكم عطر ورد؟', 'الإرجاع', 'الإرجاع متاح خلال 7 أيام');
  assert.equal(score, 0);
});
