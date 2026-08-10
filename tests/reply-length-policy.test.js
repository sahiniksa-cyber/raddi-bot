'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enforceReplyBudget,
  resolveReplyBudgetPolicy,
  validateAndRepair,
} = require('../src/services/ai/reply-validator');
const { finalizeReply } = require('../src/services/ai/final-reply-pipeline');

test('short reply policy enforces character, sentence, and line limits at complete boundaries', () => {
  const reply = 'الخيار الأول متوفر الآن. الخيار الثاني متوفر غداً. هذه جملة ثالثة زائدة ولا يحتاجها العميل.';
  const result = enforceReplyBudget(reply, {
    maxCharacters: 70,
    maxSentences: 2,
    maxLines: 2,
  });

  assert.equal(result.valid, true);
  assert.equal(result.shortened, true);
  assert.ok(result.reply.length <= 70);
  assert.equal((result.reply.match(/[.؟!](?:\s|$)/g) || []).length, 2);
  assert.doesNotMatch(result.reply, /جملة ثالثة/);
  assert.match(result.reply, /[.؟!]$/);
});

test('reply budget preserves protected product facts and complete URLs through an explicit exception', () => {
  const url = 'https://shop.example/adobe';
  const reply = `4 أشهر بـ189 ريال. 8 أشهر بـ319 ريال. رابط الاشتراك ${url}`;
  const result = enforceReplyBudget(
    reply,
    { maxCharacters: 45, maxSentences: 1, maxLines: 1 },
    ['319 ريال', url],
  );

  assert.equal(result.valid, true);
  assert.equal(result.exception, 'protected_content');
  assert.match(result.reply, /319 ريال/);
  assert.match(result.reply, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('reply budget refuses a blind mid-word cut when no complete safe boundary exists', () => {
  const result = enforceReplyBudget(
    'كلمةطويلةجداً'.repeat(30),
    { maxCharacters: 60, maxSentences: 2, maxLines: 2 },
  );

  assert.equal(result.valid, false);
  assert.equal(result.reply, '');
  assert.equal(result.reason, 'no_complete_boundary');
});

test('resolveReplyBudgetPolicy makes short mode a hard two-sentence policy', () => {
  assert.deepEqual(
    resolveReplyBudgetPolicy({
      maxResponseLength: 140,
      replyStyle: { useShortReplies: true },
    }),
    { maxCharacters: 140, maxSentences: 2, maxLines: 2 },
  );
});

test('the shortened reply is revalidated for product facts before it is sendable', async () => {
  const config = {
    maxResponseLength: 60,
    replyStyle: { useShortReplies: true },
    products: [{
      id: 'adobe',
      name: 'أدوبي',
      variants: [{ id: 'adobe-4m', label: '4 أشهر', price: '189 ريال' }],
    }],
  };
  const shortened = await validateAndRepair({
    reply: 'أدوبي 4 أشهر بـ189 ريال. أدوبي 8 أشهر بـ289 ريال وهذا الخيار غير صحيح.',
    config,
    customerText: 'كم الأربعة أشهر؟',
    matched: [],
  });
  const final = finalizeReply({
    draft: shortened,
    history: [],
    customerText: 'كم الأربعة أشهر؟',
    config,
  });

  assert.equal(final.decision, 'validated');
  assert.match(final.reply, /4 أشهر.*189 ريال/);
  assert.doesNotMatch(final.reply, /289/);
});
