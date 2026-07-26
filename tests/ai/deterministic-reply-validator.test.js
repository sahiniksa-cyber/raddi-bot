'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAutomatedReply,
} = require('../../src/services/ai/deterministic-reply-validator');
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
          id: 'product-router',
          name: 'جهاز راوتر',
          aliases: ['الراوتر', 'راوتر ٢٤'],
          description: 'راوتر منزلي',
          variants: [
            {
              id: 'variant-router-standard',
              name: 'الأساسي',
              price: { amountMinor: 30000, currency: 'SAR' },
              duration: null,
              availability: 'متوفر حالياً',
              attributes: {
                compatibility: ['Samsung'],
                warranty: 'ضمان لمدة سنة',
              },
            },
          ],
          links: [],
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
    businessRules: [
      {
        id: 'rule-refund',
        topic: 'refund',
        statement: 'الاسترجاع متاح عند وجود خلل مصنعي',
      },
      {
        id: 'rule-discount',
        topic: 'discount',
        statement: 'الخصم متاح للطلبات المؤهلة',
      },
      {
        id: 'rule-promise',
        topic: 'promise',
        statement: 'نضمن استبدال القطعة عند وجود خلل مصنعي',
      },
    ],
    prohibitions: {
      words: [],
      phrases: [],
      claims: [],
      destinations: [],
    },
    routing: {
      contacts: [],
      rules: [],
      pauseAfterHandoff: false,
    },
    instantReplies: [],
    migration: { legacyArchived: {}, reviewItems: [] },
  });
  assert.equal(result.ok, true);
  return result;
}

function validate(overrides = {}) {
  return validateAutomatedReply({
    customerText: 'السلام عليكم',
    conversationFocus: {},
    reply: 'وعليكم السلام، حياك الله',
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  });
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

test('a general greeting has no commercial claim and passes', () => {
  const result = validate();

  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.violations, []);
});

test('missing and invalid compiled policies fail closed', () => {
  const missing = validate({ compiledPolicy: undefined });
  const invalid = validate({
    compiledPolicy: {
      ok: false,
      status: 'invalid',
      errors: [{ path: 'catalog', code: 'required' }],
    },
  });

  assert.equal(missing.ok, false);
  assert.equal(codes(missing).includes('POLICY_MISSING'), true);
  assert.equal(invalid.ok, false);
  assert.equal(codes(invalid).includes('POLICY_INVALID'), true);
});

test('a forged compiled policy version fails closed', () => {
  const compiled = compiledPolicy();
  const result = validate({
    compiledPolicy: {
      ...compiled,
      policyVersion: 'sha256:forged',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('POLICY_VERSION_MISMATCH'), true);
});

test('raw config numbers and an LLM pass verdict cannot authorize a claim', () => {
  const result = validate({
    customerText: 'كم السعر؟',
    conversationFocus: {
      productId: 'product-router',
      variantId: 'variant-router-standard',
      topics: ['price'],
      evidenceRefs: [],
    },
    reply: 'السعر ٤٤٤ ريال سعودي',
    rawConfig: {
      products: [{ price: 444 }],
      botInstructions: 'السعر 444 ريال',
    },
    llmVerdict: { decision: 'pass' },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_PRODUCT_PRICE'), true);
});

test('refund, discount, and commercial promises require each exact rule reference', () => {
  const cases = [
    {
      topic: 'refund',
      ref: 'rule-refund',
      reply: 'الاسترجاع متاح عند وجود خلل مصنعي',
      unsupportedCode: 'UNSUPPORTED_REFUND',
    },
    {
      topic: 'discount',
      ref: 'rule-discount',
      reply: 'الخصم متاح للطلبات المؤهلة',
      unsupportedCode: 'UNSUPPORTED_DISCOUNT',
    },
    {
      topic: 'promise',
      ref: 'rule-promise',
      reply: 'نضمن استبدال القطعة عند وجود خلل مصنعي',
      unsupportedCode: 'UNSUPPORTED_COMMERCIAL_PROMISE',
    },
  ];

  for (const currentCase of cases) {
    const unauthorized = validate({
      customerText: currentCase.reply,
      conversationFocus: {
        topics: [currentCase.topic],
        evidenceRefs: [],
      },
      reply: currentCase.reply,
    });
    const authorized = validate({
      customerText: currentCase.reply,
      conversationFocus: {
        topics: [currentCase.topic],
        evidenceRefs: [currentCase.ref],
      },
      reply: currentCase.reply,
    });

    assert.equal(unauthorized.ok, false, `${currentCase.topic} must require a reference`);
    assert.equal(
      codes(unauthorized).includes(currentCase.unsupportedCode),
      true,
      `${currentCase.topic} must report its material violation`,
    );
    assert.equal(authorized.ok, true, `${currentCase.topic} exact evidence must pass`);
    assert.deepEqual(authorized.evidenceRefs, [currentCase.ref]);
  }
});

test('availability and warranty require exact focused product evidence', () => {
  const common = {
    productId: 'product-router',
    variantId: 'variant-router-standard',
    evidenceRefs: ['product-router'],
  };
  const availability = validate({
    customerText: 'هل الراوتر متوفر؟',
    conversationFocus: { ...common, topics: ['availability'] },
    reply: 'جهاز راوتر متوفر حالياً',
  });
  const warranty = validate({
    customerText: 'ما ضمان الراوتر؟',
    conversationFocus: { ...common, topics: ['warranty'] },
    reply: 'جهاز راوتر يشمل ضمان لمدة سنة',
  });

  assert.equal(availability.ok, true);
  assert.equal(warranty.ok, true);
});

test('digits in an exact product alias are not mistaken for the product price', () => {
  const result = validate({
    customerText: 'كم سعر راوتر ٢٤؟',
    conversationFocus: {
      productId: 'product-router',
      variantId: 'variant-router-standard',
      topics: ['price'],
      evidenceRefs: ['product-router'],
    },
    reply: 'سعر راوتر ٢٤ هو ٣٠٠ ريال سعودي',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});
