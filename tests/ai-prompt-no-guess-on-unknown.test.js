'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

function createClient(config) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...config },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {} },
  );
}

test('prompt forbids guessing and requires clarify-or-escalate on not-understood requests', () => {
  const ai = createClient({ storeName: 'متجر اختبار' });
  const sys = ai.buildSystemPrompt([{ role: 'user', content: 'شيء غير واضح' }], {});
  assert.match(sys, /إذا لم تفهم طلب العميل/);
  assert.match(sys, /اطلب توضيح|صعّد/);
});

test('prompt allows low-risk inherent product answers but forbids commercial promises', () => {
  const ai = createClient({
    storeName: 'مغسلة اختبار',
    products: [{ name: 'غسيل سيارة', description: 'غسيل خارجي للسيارة' }],
  });
  const sys = ai.buildSystemPrompt(
    [{ role: 'user', content: 'المرايا تنغسل؟' }],
    { latestUserText: 'المرايا تنغسل؟' },
  );

  assert.match(sys, /استنتاج طبيعي منخفض المخاطر/);
  assert.match(sys, /المرايا الخارجية/);
  assert.match(sys, /السعر|الضمان/);
  assert.match(sys, /لا تستنتج/);
});
