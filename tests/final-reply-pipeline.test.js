'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { finalizeReply } = require('../src/services/ai/final-reply-pipeline');

const CONFIG = {
  productCatalogVersion: 31,
  products: [
    {
      id: 'adobe',
      name: 'اشتراك أدوبي',
      variants: [
        { id: 'adobe-4m', label: '4 أشهر', price: '189 ريال' },
        { id: 'adobe-8m', label: '8 أشهر', price: '319 ريال' },
      ],
    },
    {
      id: 'freepik',
      name: 'اشتراك فري بيك',
      variants: [
        { id: 'freepik-6m', label: '6 أشهر', price: '89 ريال' },
        { id: 'freepik-1y', label: 'سنة', price: '139 ريال' },
      ],
    },
  ],
};

const HISTORY = [
  { role: 'user', content: 'أدور على اشتراك أدوبي' },
  { role: 'assistant', content: 'أي مدة تناسبك؟' },
];

test('an internal tuple violation cannot disappear from audit after deterministic repair', () => {
  const result = finalizeReply({
    draft: '6 أشهر بـ89 ريال، والسنة بـ139 ريال.',
    history: HISTORY,
    customerText: 'كم السنة وكم الست أشهر؟',
    config: CONFIG,
    reviewerAudit: { confidence: 1, unsupportedClaims: [] },
  });

  assert.equal(result.decision, 'validated');
  assert.equal(result.repairCount, 1);
  assert.match(result.reply, /6 أشهر.*غير متوفرة/);
  assert.match(result.reply, /السنة.*غير متوفرة/);
  assert.doesNotMatch(result.reply, /89|139/);
  assert.ok(result.audit.unsupportedClaims.length >= 2);
  assert.ok(result.audit.confidence < 1);
  assert.equal(result.audit.catalogVersion, 31);
});

test('a reviewer fallback cannot erase a product violation found in an earlier stage', () => {
  const result = finalizeReply({
    draft: 'المعلومة غير مذكورة عندي بشكل مؤكد.',
    history: HISTORY,
    customerText: 'كم السنة وكم الست أشهر؟',
    config: CONFIG,
    reviewerAudit: {
      confidence: 1,
      unsupportedClaims: [],
      deterministicIssuesAfter: [
        {
          type: 'unsupported_product_claim',
          reason: 'plan_not_found',
          value: '6 أشهر بـ89 ريال',
          productId: 'adobe',
        },
      ],
    },
  });

  assert.equal(result.decision, 'validated');
  assert.equal(result.reason, 'deterministic_product_repair');
  assert.match(result.reply, /6 أشهر.*غير متوفرة/);
  assert.match(result.reply, /السنة.*غير متوفرة/);
  assert.ok(result.audit.unsupportedClaims.some(value => /89/.test(value)));
  assert.ok(result.audit.confidence < 1);
});

test('a repaired reply is fully revalidated and blocked if the repair still invents a tuple', () => {
  let repairs = 0;
  const result = finalizeReply({
    draft: 'أدوبي 6 أشهر بـ89 ريال.',
    history: HISTORY,
    customerText: 'كم الست أشهر؟',
    config: CONFIG,
    repairReplyBuilder: () => {
      repairs++;
      return { decision: 'answer', reply: 'أدوبي 8 أشهر بـ289 ريال.' };
    },
  });

  assert.equal(repairs, 1);
  assert.equal(result.repairCount, 1);
  assert.equal(result.decision, 'blocked');
  assert.equal(result.reply, '');
  assert.ok(result.audit.finalIssues.some(issue => issue.reason === 'tuple_mismatch'));
});

test('the repair loop is capped at one attempt', () => {
  let repairs = 0;
  const result = finalizeReply({
    draft: 'أدوبي سنة بـ139 ريال.',
    history: HISTORY,
    customerText: 'كم السنة؟',
    config: CONFIG,
    repairReplyBuilder: () => {
      repairs++;
      return { decision: 'answer', reply: 'أدوبي سنة بـ139 ريال.' };
    },
    maxRepairs: 99,
  });

  assert.equal(repairs, 1);
  assert.equal(result.repairCount, 1);
  assert.equal(result.decision, 'blocked');
});

test('an unknown product produces a short clarification without exposing any catalog price', () => {
  const result = finalizeReply({
    draft: 'السنة بـ139 ريال.',
    history: [],
    customerText: 'كم السنة؟',
    config: CONFIG,
  });

  assert.equal(result.decision, 'validated');
  assert.equal(result.reason, 'safe_product_clarification');
  assert.match(result.reply, /أي منتج|اسم المنتج/);
  assert.doesNotMatch(result.reply, /\d+\s*ريال/);
});

test('a valid complete tuple passes without repair', () => {
  const result = finalizeReply({
    draft: 'أدوبي 8 أشهر بـ319 ريال.',
    history: HISTORY,
    customerText: 'كم الثمان أشهر؟',
    config: CONFIG,
  });

  assert.equal(result.decision, 'validated');
  assert.equal(result.repairCount, 0);
  assert.equal(result.reply, 'أدوبي 8 أشهر بـ319 ريال.');
  assert.deepEqual(result.audit.initialIssues, []);
  assert.deepEqual(result.audit.finalIssues, []);
});
