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

test('long custom instructions do not contradict embedded product knowledge when products fields are empty', () => {
  const ai = createClient({
    botInstructions: `${'x'.repeat(301)}

## المنتجات والأسعار
أدوبي كريتيف كلاود
شهر — 59 ريال
لا تنسيق أو ترميز في الردود`,
    products: [],
  });

  const prompt = ai.buildSystemPrompt([], {});

  assert.match(prompt, /أدوبي كريتيف كلاود/);
  assert.doesNotMatch(prompt, /لا توجد منتجات مضافة/);
  assert.doesNotMatch(prompt, /نظّم المعلومات/);
  assert.match(prompt, /لا تخترع/);
});

test('prompt makes escalation marker mandatory when escalation contacts exist', () => {
  const ai = createClient({
    botInstructions: `${'x'.repeat(301)}
متى تحوّل للمالك: سؤال ما تعرف إجابته`,
    escalationContacts: [
      { name: 'محمد', phone: '0562529945', role: 'المالك', when: 'سؤال ما تعرف إجابته' },
    ],
  });

  const prompt = ai.buildSystemPrompt([], {});

  assert.match(prompt, /\[تحويل:/);
  assert.match(prompt, /يجب/);
  assert.match(prompt, /0562529945/);
});
