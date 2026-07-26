'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeterministicFallback,
} = require('../../src/services/ai/deterministic-fallback');
const {
  compileMerchantPolicy,
} = require('../../src/policy/merchant-policy-compiler');
const {
  PLATFORM_REPLY_POLICY,
} = require('../../src/policy/platform-reply-policy');

function compiledPolicy() {
  const result = compileMerchantPolicy({
    schemaVersion: 1,
    status: 'active',
    catalog: {
      products: [
        {
          id: 'product-package-24',
          name: 'باقة ٢٤',
          aliases: ['الباقة المرنة'],
          description: '',
          variants: [
            {
              id: 'variant-package-24',
              name: 'الأساسية',
              price: { amountMinor: 24000, currency: 'SAR' },
              duration: 'أربعة وعشرون شهراً',
              availability: 'متاحة',
              attributes: {},
            },
          ],
          links: ['https://merchant.invalid/package-24'],
          attributes: {},
        },
      ],
    },
    persona: {
      role: 'customer_service_agent',
      displayName: null,
      language: 'ar',
      dialect: 'saudi',
      tone: 'ودود',
      brevity: 'concise',
      formatting: {},
    },
    businessRules: [],
    prohibitions: { words: [], phrases: [], claims: [], destinations: [] },
    routing: {
      contacts: [
        {
          id: 'contact-support',
          name: 'الدعم',
          phoneNumber: '+966500000000',
        },
      ],
      rules: [],
      pauseAfterHandoff: false,
    },
    instantReplies: [],
    migration: { legacyArchived: {}, reviewItems: [] },
  });
  assert.equal(result.ok, true);
  return result;
}

function build(overrides = {}) {
  return buildDeterministicFallback({
    customerText: 'فضلاً ساعدني',
    conversationFocus: { topics: [], evidenceRefs: [] },
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  });
}

function assertContainsNoUngroundedMaterial(reply) {
  assert.doesNotMatch(reply, /[0-9٠-٩۰-۹]/u);
  assert.doesNotMatch(reply, /(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/iu);
  assert.doesNotMatch(reply, /(?:ريال|ر\.?\s?س|sar|usd|دولار|درهم|دينار|يورو|سعر)/iu);
  assert.doesNotMatch(
    reply,
    /(?:يوم|أيام|ايام|أسبوع|اسبوع|شهر|أشهر|اشهر|سنة|سنه|سنوات|day|week|month|year)/iu,
  );
  assert.doesNotMatch(
    reply,
    /(?:نضمن|أضمن|اضمن|نتعهد|متاح|متوفر|استرجاع|استرداد|ضمان|خصم|تخفيض|توصيل مجاني|شحن مجاني|promise|available|refund|warranty|discount|free delivery)/iu,
  );
}

test('fallback with no evidence uses a finite material-free template', () => {
  const result = build();

  assert.equal(result.templateId, 'clarify');
  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.evidenceRefs, []);
  assertContainsNoUngroundedMaterial(result.reply);
});
test('missing or raw-config-only evidence cannot add a number to fallback', () => {
  const result = build({
    evidenceRef: 'contact-missing',
    rawConfig: {
      customerServicePhone: '0593216744',
      botInstructions: 'تواصل على 0593216744',
    },
  });

  assert.equal(result.templateId, 'clarify');
  assert.equal(result.validation.ok, true);
  assertContainsNoUngroundedMaterial(result.reply);
});

test('an authorized contact reference renders only the exact canonical phone', () => {
  const result = build({
    customerText: 'كيف أتواصل مع الدعم؟',
    conversationFocus: {
      topics: ['contact'],
      evidenceRefs: ['contact-support'],
    },
    evidenceRef: 'contact-support',
  });

  assert.equal(result.templateId, 'contact');
  assert.equal(result.reply.includes('+966500000000'), true);
  assert.equal(result.reply.includes('0593216744'), false);
  assert.deepEqual(result.evidenceRefs, ['contact-support']);
  assert.equal(result.validation.ok, true);
});

test('an authorized numeric product name may render only from its exact reference', () => {
  const result = build({
    customerText: 'أي باقة تقصد؟',
    conversationFocus: {
      productId: 'product-package-24',
      topics: [],
      evidenceRefs: ['product-package-24'],
    },
    evidenceRef: 'product-package-24',
  });

  assert.equal(result.templateId, 'product');
  assert.equal(result.reply.includes('باقة ٢٤'), true);
  assert.equal(result.reply.includes('240'), false);
  assert.deepEqual(result.evidenceRefs, ['product-package-24']);
  assert.equal(result.validation.ok, true);
});

test('an evidence-backed rendering that is irrelevant is discarded and revalidated safely', () => {
  const result = build({
    customerText: 'السلام عليكم',
    conversationFocus: {
      topics: ['greeting'],
      evidenceRefs: ['contact-support'],
    },
    evidenceRef: 'contact-support',
  });

  assert.equal(result.templateId, 'clarify');
  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.evidenceRefs, []);
  assertContainsNoUngroundedMaterial(result.reply);
});
