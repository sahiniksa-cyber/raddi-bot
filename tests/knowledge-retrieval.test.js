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

const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');

const POLICIES = {
  'الشحن': 'الشحن مجاني فوق 200 ريال ويوصل خلال 2-4 أيام عبر سمسا',
  'الدفع': 'نوفر الدفع عند الاستلام ومدى وآبل باي',
  'الإرجاع': 'الإرجاع متاح خلال 7 أيام بشرط أن المنتج لم يُفتح',
};

test('retrieve injects matched policy block with constraint warning', () => {
  const { block, matched } = retrieveRelevantPolicies(
    { autoReplyKeywords: POLICIES }, 'متى يوصلني الطلب؟');
  assert.match(block, /سياسات_المتجر_الجاهزة/);
  assert.match(block, /سمسا/);                       // الرد المطابق محقون
  assert.match(block, /مواصفات.*المنتجات.*عدم الاختراع/s); // تحذير ث1
  assert.ok(matched.some(m => m.keyword === 'الشحن'));
});

test('retrieve returns empty block when no policies', () => {
  const { block, matched } = retrieveRelevantPolicies({ autoReplyKeywords: {} }, 'مرحبا');
  assert.equal(block, '');
  assert.equal(matched.length, 0);
});

test('retrieve includes all policies when small set and nothing matched', () => {
  const { block } = retrieveRelevantPolicies({ autoReplyKeywords: POLICIES }, 'كلمة غير متعلقة xyz');
  // المجموعة صغيرة (<=8) → احقن الكل كأمان
  assert.match(block, /سمسا/);
  assert.match(block, /آبل باي/);
});
