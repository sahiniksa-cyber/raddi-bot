'use strict';

// Legacy-path regression lock: asserts the CURRENT (default) prompt wording.
// Pin the style/brevity flags OFF so this file deterministically tests the
// legacy path regardless of ambient env. New-path behavior is locked in
// tests/reply-voice-newpath-locks.test.js.
process.env.PROMPT_STYLE_SPLIT_ENABLED = "false";
delete process.env.BREVITY_AUTHORITY_ENABLED;
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

test('system prompt instructs answering every question', () => {
  const ai = createClient({ storeName: 'متجر اختبار' });
  const sys = ai.buildSystemPrompt([{ role: 'user', content: 'كم سعر المنتج؟ وهل يتوفر بالأزرق؟' }], {});
  assert.match(sys, /جاوب على (جميع|كل) الأسئلة/);
});

test('system prompt does not contain the contradictory one-path-only phrase', () => {
  const ai = createClient({ storeName: 'متجر اختبار' });
  const sys = ai.buildSystemPrompt([{ role: 'user', content: 'ما هي مواعيدكم وكيف أطلب؟' }], {});
  assert.doesNotMatch(sys, /مساراً واحداً واضحاً فقط/);
});
