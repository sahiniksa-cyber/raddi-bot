'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');
const {
  buildFinalPreSendReviewMessages,
  buildQualityReviewMessages,
} = require('../src/services/ai/reply-quality-gate');

const CUSTOMER_MESSAGE = 'طلع ما عندكم اشتراك سنة، وغالي مرة أبيه أقل من ٢٠٠، جزاك الله خير';

function createClient(config = {}) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...config },
    { info() {}, warn() {}, error() {} },
    { record() {} },
  );
}

test('generation prompt treats a closed price objection as sentiment, not a missing-data question', () => {
  const prompt = createClient().buildSystemPrompt(
    [{ role: 'user', content: CUSTOMER_MESSAGE }],
    { latestUserText: CUSTOMER_MESSAGE },
  );

  assert.match(prompt, /فرّق بين السؤال أو الطلب المفتوح وبين الملاحظة أو الاعتراض أو إنهاء الحديث/);
  assert.match(prompt, /اعتراض على السعر.*لا تخترع.*ولا تصعّد/s);
  assert.match(prompt, /اعترف بشعوره.*رد قصير طبيعي/s);
});

test('both quality reviewers preserve human acknowledgement for a closed price objection', () => {
  const args = {
    draft: 'الله يجزاك خير، ومتفهم إن السعر ما ناسبك',
    customerText: CUSTOMER_MESSAGE,
    history: [{ role: 'user', content: CUSTOMER_MESSAGE }],
    config: DEFAULT_CONFIG,
  };
  const qualitySystem = buildQualityReviewMessages(args)[0].content;
  const finalSystem = buildFinalPreSendReviewMessages(args)[0].content;

  for (const prompt of [qualitySystem, finalSystem]) {
    assert.match(prompt, /ذكر العميل لميزانيته أو مدة يتمناها لا يعني أنه يسأل عنها/);
    assert.match(prompt, /لا تعتبرها معلومة ناقصة ولا سبباً للتصعيد/);
    assert.match(prompt, /حافظ على الرد الطبيعي المتعاطف/);
  }
});
