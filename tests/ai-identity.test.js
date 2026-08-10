'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');

const logger = { info() {}, warn() {}, error() {} };

test('employee name is not injected when it exists but is not explicitly enabled', () => {
  const ai = new AIClient({
    storeName: 'متجر الاختبار',
    replyStyle: {
      employeeName: 'محمد',
      employeeNameEnabled: false,
      avoidWords: ['كلمة خاصة'],
    },
  }, logger, { record() {} });

  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }]);
  assert.doesNotMatch(prompt, /محمد/);
  assert.match(prompt, /موظف خدمة العملاء/);
  assert.match(prompt, /ذكاء اصطناعي/);
  assert.match(prompt, /كلمة خاصة/);
});

test('employee name is injected only when the merchant explicitly enables it', () => {
  const ai = new AIClient({
    storeName: 'متجر الاختبار',
    replyStyle: {
      employeeName: 'سارة',
      employeeNameEnabled: true,
    },
  }, logger, { record() {} });

  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }]);
  assert.match(prompt, /سارة/);
});
