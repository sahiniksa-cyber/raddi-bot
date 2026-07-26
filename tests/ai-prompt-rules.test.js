'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { canonicalConfig, product } = require('./helpers/canonical-config');

function createClient(config) {
  return new AIClient(
    config,
    { info() {}, warn() {}, error() {} },
    { record() {} },
  );
}

test('canonical product knowledge is rendered and legacy product prose is ignored', () => {
  const ai = createClient({
    ...canonicalConfig({
      products: [product({
        id: 'adobe',
        name: 'أدوبي كريتيف كلاود',
        variants: [{
          id: 'adobe-month',
          name: 'شهر',
          price: { amountMinor: 5900, currency: 'SAR' },
        }],
      })],
    }),
    products: [{ name: 'منتج قديم', price: '999' }],
  });
  const prompt = ai.buildSystemPrompt(
    [{ role: 'user', content: 'كم سعر ادوبي شهر؟' }],
    {},
  );
  assert.match(prompt, /أدوبي كريتيف كلاود/);
  assert.match(prompt, /59\.00 SAR/);
  assert.doesNotMatch(prompt, /منتج قديم|999/);
});

test('prompt forbids model-created escalation markers and exposes no legacy contact', () => {
  const ai = createClient({
    ...canonicalConfig(),
    escalationContacts: [{ phone: '0562529945' }],
  });
  const prompt = ai.buildSystemPrompt([], {});
  assert.match(prompt, /لا تُنشئ علامة تصعيد|لا تنشئ علامة تصعيد/);
  assert.doesNotMatch(prompt, /0562529945|\[تحويل:/);
});

test('canonical persona controls the prompt and legacy replyStyle cannot override it', () => {
  const ai = createClient({
    ...canonicalConfig({
      persona: {
        displayName: 'سارة',
        language: 'ar',
        dialect: 'neutral',
        tone: 'formal',
        brevity: 'concise',
      },
    }),
    replyStyle: { employeeName: 'اسم قديم', tone: 'legacy-tone' },
  });
  const prompt = ai.buildSystemPrompt([], {});
  assert.match(prompt, /displayName: سارة/);
  assert.match(prompt, /tone: formal/);
  assert.doesNotMatch(prompt, /اسم قديم|legacy-tone/);
});
