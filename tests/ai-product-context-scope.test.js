'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');

const logger = { info() {}, warn() {}, error() {} };
const config = {
  storeName: 'متجر الاختبار',
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
  replyStyle: { emojiLevel: 'none' },
};

test('system prompt exposes only Adobe facts for an Adobe duration-only follow-up', () => {
  const ai = new AIClient(config, logger, { record() {} });
  const prompt = ai.buildSystemPrompt([
    { role: 'user', content: 'أدور على اشتراك أدوبي' },
    { role: 'assistant', content: 'أي مدة تناسبك؟' },
    { role: 'user', content: 'كم السنة وكم الست أشهر؟' },
  ]);

  assert.match(prompt, /أدوبي/);
  assert.match(prompt, /189 ريال/);
  assert.match(prompt, /319 ريال/);
  assert.doesNotMatch(prompt, /فري بيك/);
  assert.doesNotMatch(prompt, /(?:^|[^\d])(?:89|139)\s*ريال/m);
});

test('system prompt exposes no product prices while product focus is unknown', () => {
  const ai = new AIClient(config, logger, { record() {} });
  const prompt = ai.buildSystemPrompt([
    { role: 'user', content: 'كم السعر؟' },
  ]);

  assert.doesNotMatch(prompt, /189 ريال|319 ريال|(?:^|[^\d])89 ريال|139 ريال/m);
  assert.match(prompt, /المنتج غير محدد|اطلب اسم المنتج/);
});
