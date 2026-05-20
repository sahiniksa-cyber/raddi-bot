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

  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'كم سعر ادوبي شهر؟' }], {});

  assert.match(prompt, /أدوبي كريتيف كلاود/);
  assert.match(prompt, /المنتجات المطابقة لسؤال العميل/);
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

test('long custom instructions still include dashboard reply controls', () => {
  const ai = createClient({
    botInstructions: 'تعليمات المالك '.repeat(40),
    responseLanguage: 'العربية الفصحى السهلة',
    maxResponseLength: 120,
    replyStyle: {
      employeeName: 'سارة',
      tone: 'رسمي ومحترف',
      languageStyle: 'standard',
      useDialect: false,
      dialect: 'السعودية النجدية',
      emojiLevel: 'none',
      replyLength: 'short',
      useShortReplies: true,
      greetingPhrases: ['مرحباً بك'],
      closingPhrases: ['يسعدني خدمتك'],
      avoidWords: ['بوت'],
    },
  });

  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }], {});

  assert.match(prompt, /تعليمات المالك/);
  assert.match(prompt, /سارة/);
  assert.match(prompt, /رسمي ومحترف/);
  assert.match(prompt, /العربية الفصحى السهلة/);
  assert.match(prompt, /بدون إيموجي/);
  assert.match(prompt, /قصير/);
  assert.match(prompt, /مرحباً بك/);
  assert.match(prompt, /يسعدني خدمتك/);
  assert.match(prompt, /120/);
});
