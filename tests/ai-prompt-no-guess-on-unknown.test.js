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
