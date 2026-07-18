'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasMerchantKnowledge,
  merchantKnowledgeReadiness,
} = require('../src/services/ai/merchant-knowledge-readiness');

test('empty/default operational settings are not treated as merchant knowledge', () => {
  const result = merchantKnowledgeReadiness({
    storeName: 'متجري',
    welcomeMessage: 'أهلًا بك',
    fallbackMessage: 'لحظات من فضلك',
    openaiApiKey: 'platform-key',
    model: 'gpt-4o',
    replyTone: 'friendly',
    products: [],
    autoReplyKeywords: {},
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'missing_merchant_knowledge');
  assert.deepEqual(result.sources, []);
});

test('each supported merchant-owned content source can enable grounded replies', () => {
  const cases = [
    [{ storeDescription: 'متجر مختص بالشنط' }, 'store_description'],
    [{ workingHours: 'يوميًا من 9 إلى 5' }, 'working_hours'],
    [{ botInstructions: 'لا تذكر سعرًا غير موجود' }, 'bot_instructions'],
    [{ products: [{ name: 'شنطة سفر', price: '120' }] }, 'products'],
    [{ autoReplyKeywords: { الشحن: 'الشحن خلال يومين' } }, 'approved_replies'],
    [{ learnedReplies: [{ keyword: 'الضمان', reply: 'الضمان سنة' }] }, 'learned_replies'],
  ];

  for (const [config, source] of cases) {
    const result = merchantKnowledgeReadiness(config);
    assert.equal(result.ready, true, source);
    assert.ok(result.sources.includes(source));
    assert.equal(hasMerchantKnowledge(config), true);
  }
});

test('empty products and incomplete reply entries do not bypass the gate', () => {
  assert.equal(hasMerchantKnowledge({
    products: [{}],
    autoReplyKeywords: { الشحن: '' },
    learnedReplies: [{ keyword: 'الضمان', reply: '' }],
  }), false);
});
