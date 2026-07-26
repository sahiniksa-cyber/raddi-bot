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
          id: 'product-alpha',
          name: 'باقة ألف',
          aliases: ['ألف', 'Alpha'],
          description: 'اشتراك أساسي',
          variants: [
            {
              id: 'variant-alpha-monthly',
              name: 'شهري',
              price: { amountMinor: 10000, currency: 'SAR' },
              duration: 'شهر واحد',
              availability: 'متاح',
              attributes: {
                compatibility: ['Samsung'],
                warranty: 'ضمان لمدة سنة',
              },
            },
            {
              id: 'variant-alpha-annual',
              name: 'سنوي',
              price: { amountMinor: 90000, currency: 'SAR' },
              duration: 'اثنا عشر شهراً',
              availability: 'متاح',
              attributes: {
                compatibility: ['Samsung'],
                warranty: 'ضمان لمدة سنتين',
              },
            },
          ],
          links: ['https://merchant.invalid/alpha'],
          attributes: {},
        },
        {
          id: 'product-beta',
          name: 'باقة باء',
          aliases: ['باء', 'Beta'],
          description: 'اشتراك احترافي',
          variants: [
            {
              id: 'variant-beta-quarter',
              name: 'ربع سنوي',
              price: { amountMinor: 20000, currency: 'SAR' },
              duration: 'ثلاثة أشهر',
              availability: 'حسب الطلب',
              attributes: {
                compatibility: ['iPhone'],
                warranty: 'ضمان لمدة ستة أشهر',
              },
            },
          ],
          links: ['https://merchant.invalid/beta'],
          attributes: {},
        },
      ],
    },
    persona: {
      role: 'customer_service_agent',
      displayName: 'فريق ٧٧٧',
      language: 'ar',
      dialect: 'saudi',
      tone: 'ودود',
      brevity: 'concise',
      formatting: {},
    },
    businessRules: [
      {
        id: 'rule-delivery',
        topic: 'delivery',
        statement: 'التوصيل متاح',
      },
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
    migration: {
      legacyArchived: {
        botInstructions: 'سعر قديم ٧٧٧ ورقم قديم 0555777777',
      },
      reviewItems: [],
    },
  });
  assert.equal(result.ok, true);
  return result;
}

function validate(reply, conversationFocus, customerText = 'أعطني التفاصيل') {
  return validateAutomatedReply({
    customerText,
    conversationFocus,
    reply,
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
  });
}

function violationCodes(result) {
  return result.violations.map((violation) => violation.code);
}

test('a price belonging to Product A cannot authorize Product B', () => {
  const result = validate('سعر باقة باء ١٠٠ ريال سعودي', {
    productId: 'product-beta',
    variantId: 'variant-beta-quarter',
    topics: ['price'],
    evidenceRefs: ['product-beta'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_PRODUCT_PRICE'), true);
});

test('a duration belonging to one variant cannot authorize another variant', () => {
  const result = validate('مدة باقة ألف شهر واحد', {
    productId: 'product-alpha',
    variantId: 'variant-alpha-annual',
    topics: ['duration'],
    evidenceRefs: ['product-alpha'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_DURATION'), true);
});

test('Samsung compatibility on Product A cannot authorize iPhone compatibility', () => {
  const result = validate('باقة ألف متوافقة مع iPhone', {
    productId: 'product-alpha',
    variantId: 'variant-alpha-monthly',
    topics: ['compatibility'],
    evidenceRefs: ['product-alpha'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_COMPATIBILITY'), true);
});

test('ordinary delivery evidence cannot authorize free delivery', () => {
  const result = validate('التوصيل مجاني', {
    topics: ['delivery'],
    evidenceRefs: ['rule-delivery'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_DELIVERY'), true);
});

test('one product warranty cannot authorize a different product warranty', () => {
  const result = validate('باقة باء تشمل ضمان لمدة سنة', {
    productId: 'product-beta',
    variantId: 'variant-beta-quarter',
    topics: ['warranty'],
    evidenceRefs: ['product-beta'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_WARRANTY'), true);
});

test('availability is bound to the exact focused product variant', () => {
  const result = validate('باقة باء متاحة', {
    productId: 'product-beta',
    variantId: 'variant-beta-quarter',
    topics: ['availability'],
    evidenceRefs: ['product-beta'],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_AVAILABILITY'), true);
});

test('numbers in persona and archived legacy text authorize nothing', () => {
  const result = validate('رمز الخدمة ٧٧٧', {
    topics: ['number'],
    evidenceRefs: [],
  });

  assert.equal(result.ok, false);
  assert.equal(violationCodes(result).includes('UNSUPPORTED_NUMBER'), true);
});

test('an exact canonical product fact passes with its product evidence reference', () => {
  const result = validate('سعر باقة ألف ١٠٠ ريال سعودي', {
    productId: 'product-alpha',
    variantId: 'variant-alpha-monthly',
    topics: ['price'],
    evidenceRefs: ['product-alpha'],
  }, 'كم سعر باقة ألف؟');

  assert.equal(result.ok, true);
  assert.deepEqual(result.evidenceRefs, ['product-alpha']);
  assert.deepEqual(result.violations, []);
});

test('only the exact canonical product URL is authorized', () => {
  const exact = validate('رابط باقة ألف https://merchant.invalid/alpha', {
    productId: 'product-alpha',
    topics: ['url'],
    evidenceRefs: ['product-alpha'],
  }, 'أرسل رابط باقة ألف');
  const invented = validate('رابط باقة ألف https://merchant.invalid/beta', {
    productId: 'product-alpha',
    topics: ['url'],
    evidenceRefs: ['product-alpha'],
  }, 'أرسل رابط باقة ألف');

  assert.equal(exact.ok, true);
  assert.equal(invented.ok, false);
  assert.equal(violationCodes(invented).includes('UNSUPPORTED_URL'), true);
});
