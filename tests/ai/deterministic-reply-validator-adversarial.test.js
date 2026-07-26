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
          name: 'راوتر برو',
          aliases: ['الراوتر'],
          description: 'راوتر منزلي',
          variants: [
            {
              id: 'variant-router-monthly',
              name: 'شهري',
              price: { amountMinor: 12345, currency: 'SAR' },
              duration: 'شهر واحد',
              availability: 'متوفر',
              attributes: {
                aliases: ['Monthly'],
                compatibility: ['Samsung'],
                warranty: 'ضمان لمدة سنة',
              },
            },
            {
              id: 'variant-router-annual',
              name: 'سنوي',
              price: { amountMinor: 99999, currency: 'SAR' },
              duration: 'اثنا عشر شهراً',
              availability: 'غير متوفر',
              attributes: {
                aliases: ['Annual'],
                compatibility: ['iPhone'],
                warranty: 'ضمان لمدة سنتين',
              },
            },
          ],
          links: ['https://Merchant.Invalid/ExactPath'],
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
        id: 'rule-delivery',
        topic: 'delivery',
        statement: 'التوصيل متاح برسوم',
      },
      {
        id: 'rule-refund',
        topic: 'refund',
        statement: 'الاسترجاع متاح عند وجود خلل مصنعي',
      },
      {
        id: 'rule-discount',
        topic: 'discount',
        statement: 'الخصم عشرة بالمئة للطلبات المؤهلة',
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
    migration: { legacyArchived: {}, reviewItems: [] },
  });
  assert.equal(result.ok, true);
  return result;
}

function productFocus(overrides = {}) {
  return {
    productId: 'product-router',
    variantId: 'variant-router-monthly',
    topics: [],
    evidenceRefs: ['product-router'],
    ...overrides,
  };
}

function validate(overrides = {}) {
  return validateAutomatedReply({
    customerText: 'السلام عليكم',
    conversationFocus: {},
    reply: 'وعليكم السلام',
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  });
}

function codes(result) {
  return result.violations.map(violation => violation.code);
}

test('forged caller indexes cannot authorize a product absent from canonical policy', () => {
  const canonical = compiledPolicy();
  const fakeProduct = {
    id: 'product-forged',
    name: 'المنتج المزيف',
    aliases: ['مزيف'],
    description: '',
    variants: [
      {
        id: 'variant-forged',
        name: 'الوحيد',
        price: { amountMinor: 77700, currency: 'SAR' },
        duration: null,
        availability: null,
        attributes: {},
      },
    ],
    links: [],
    attributes: {},
  };
  const forged = {
    ...canonical,
    indexes: {
      ...canonical.indexes,
      productsById: {
        ...canonical.indexes.productsById,
        [fakeProduct.id]: fakeProduct,
      },
      productsByAlias: {
        ...canonical.indexes.productsByAlias,
        'المنتج المزيف': fakeProduct,
        مزيف: fakeProduct,
      },
      variantsById: {
        ...canonical.indexes.variantsById,
        'variant-forged': fakeProduct.variants[0],
      },
    },
  };

  const result = validate({
    customerText: 'كم سعر المنتج المزيف؟',
    conversationFocus: {
      productId: 'product-forged',
      variantId: 'variant-forged',
      topics: ['price'],
      evidenceRefs: ['product-forged'],
    },
    reply: 'سعر المنتج المزيف ٧٧٧ ريال سعودي',
    compiledPolicy: forged,
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('POLICY_INVALID'), true);
});

test('malformed supplied indexes fail closed instead of throwing', () => {
  const canonical = compiledPolicy();
  let result;

  assert.doesNotThrow(() => {
    result = validate({
      compiledPolicy: {
        ...canonical,
        indexes: {
          ...canonical.indexes,
          productsById: null,
        },
      },
    });
  });
  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('POLICY_INVALID'), true);
});

test('a malformed or version-forged canonical policy body fails closed', () => {
  const canonical = compiledPolicy();
  const malformed = validate({
    compiledPolicy: {
      ...canonical,
      policy: {
        status: 'active',
        policyVersion: canonical.policyVersion,
      },
    },
  });
  const forgedBody = JSON.parse(JSON.stringify(canonical.policy));
  forgedBody.catalog.products[0].description = 'forged fact';
  const forged = validate({
    compiledPolicy: {
      ...canonical,
      policy: forgedBody,
    },
  });

  assert.equal(malformed.ok, false);
  assert.equal(codes(malformed).includes('POLICY_INVALID'), true);
  assert.equal(forged.ok, false);
  assert.equal(
    codes(forged).some(code => ['POLICY_INVALID', 'POLICY_VERSION_MISMATCH'].includes(code)),
    true,
  );
});

test('a decimal minor-unit amount in caller policy data fails schema validation', () => {
  const canonical = compiledPolicy();
  const decimalMinorPolicy = JSON.parse(JSON.stringify(canonical.policy));
  decimalMinorPolicy.catalog.products[0].variants[0].price.amountMinor = 12345.5;

  const result = validate({
    compiledPolicy: {
      ...canonical,
      policy: decimalMinorPolicy,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('POLICY_INVALID'), true);
});

test('an arbitrary caller platform policy has no authority', () => {
  const result = validate({
    platformPolicy: {
      policyVersion: 'sha256:caller-controlled',
      invariants: {
        automatedRepliesRequireActiveMerchantPolicy: true,
        merchantFactsComeOnlyFromCanonicalPolicy: true,
        probabilisticComponentsHaveNoSendAuthority: true,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('POLICY_INVALID'), true);
});

test('English and Arabic word-valued prices are material and rejected', () => {
  for (const reply of [
    'سعر الراوتر one hundred SAR',
    'سعر الراوتر مئة ريال سعودي',
  ]) {
    const result = validate({
      customerText: 'كم سعر الراوتر؟',
      conversationFocus: productFocus({ topics: ['price'] }),
      reply,
    });

    assert.equal(result.ok, false, reply);
    assert.equal(codes(result).includes('UNSUPPORTED_PRODUCT_PRICE'), true, reply);
  }
});

test('decimal prices preserve Arabic decimal punctuation and exact minor units', () => {
  for (const reply of [
    'سعر الراوتر ١٢٣٫٤٥ ريال سعودي',
    'سعر الراوتر 123.45 SAR',
  ]) {
    const result = validate({
      customerText: 'كم سعر الراوتر؟',
      conversationFocus: productFocus({ topics: ['price'] }),
      reply,
    });

    assert.equal(result.ok, true, reply);
  }
});

test('each amount is bound to its own currency instead of the first currency found', () => {
  const result = validate({
    customerText: 'كم سعر الراوتر؟',
    conversationFocus: productFocus({ topics: ['price'] }),
    reply: 'السعر ١٢٣٫٤٥ ريال سعودي أو ١٢٣٫٤٥ دولار أمريكي',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_PRODUCT_PRICE'), true);
});

test('ordinary delivery evidence cannot authorize an appended free-delivery clause', () => {
  const result = validate({
    customerText: 'كيف التوصيل وهل هو مجاني؟',
    conversationFocus: {
      topics: ['delivery'],
      evidenceRefs: ['rule-delivery'],
    },
    reply: 'التوصيل متاح برسوم ومجاني أيضاً',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_DELIVERY'), true);
});

test('positive availability evidence cannot authorize a negated availability claim', () => {
  const result = validate({
    customerText: 'هل الراوتر غير متوفر؟',
    conversationFocus: productFocus({ topics: ['availability'] }),
    reply: 'الراوتر غير متوفر',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_AVAILABILITY'), true);
});

test('a refund clause cannot suppress a separate unsupported availability clause', () => {
  const result = validate({
    customerText: 'ما الاسترجاع وهل الراوتر غير متوفر؟',
    conversationFocus: productFocus({
      topics: ['refund', 'availability'],
      evidenceRefs: ['product-router', 'rule-refund'],
    }),
    reply: 'الاسترجاع متاح عند وجود خلل مصنعي والراوتر غير متوفر',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_AVAILABILITY'), true);
});

test('stronger appended material clauses require their own exact evidence', () => {
  const cases = [
    {
      code: 'UNSUPPORTED_WARRANTY',
      focus: productFocus({ topics: ['warranty'] }),
      customerText: 'ما الضمان؟',
      reply: 'الراوتر يشمل ضمان لمدة سنة وضماناً شاملاً مدى الحياة',
    },
    {
      code: 'UNSUPPORTED_REFUND',
      focus: { topics: ['refund'], evidenceRefs: ['rule-refund'] },
      customerText: 'ما الاسترجاع؟',
      reply: 'الاسترجاع متاح عند وجود خلل مصنعي والاسترجاع فوري بلا شروط',
    },
    {
      code: 'UNSUPPORTED_DISCOUNT',
      focus: { topics: ['discount'], evidenceRefs: ['rule-discount'] },
      customerText: 'ما الخصم؟',
      reply: 'الخصم عشرة بالمئة للطلبات المؤهلة وخصم إضافي دائم',
    },
    {
      code: 'UNSUPPORTED_COMMERCIAL_PROMISE',
      focus: { topics: ['promise'], evidenceRefs: ['rule-promise'] },
      customerText: 'ماذا تضمنون؟',
      reply: 'نضمن استبدال القطعة عند وجود خلل مصنعي ونضمن النتيجة فوراً',
    },
  ];

  for (const currentCase of cases) {
    const result = validate({
      customerText: currentCase.customerText,
      conversationFocus: currentCase.focus,
      reply: currentCase.reply,
    });

    assert.equal(result.ok, false, currentCase.code);
    assert.equal(codes(result).includes(currentCase.code), true, currentCase.code);
  }
});

test('Samsung evidence cannot authorize an appended iPhone compatibility target', () => {
  const result = validate({
    customerText: 'هل الراوتر متوافق مع Samsung و iPhone؟',
    conversationFocus: productFocus({ topics: ['compatibility'] }),
    reply: 'الراوتر متوافق مع Samsung و iPhone',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_COMPATIBILITY'), true);
});

test('mentioned variant names and aliases must match the focused variant', () => {
  for (const reply of [
    'سنوي مدته شهر واحد',
    'Annual مدته شهر واحد',
  ]) {
    const result = validate({
      customerText: `ما مدة ${reply.split(' ')[0]}؟`,
      conversationFocus: productFocus({ topics: ['duration'] }),
      reply,
    });

    assert.equal(result.ok, false, reply);
    assert.equal(codes(result).includes('UNSUPPORTED_PRODUCT'), true, reply);
  }
});

test('current greeting overrides stale contact focus even without a phone number', () => {
  const result = validate({
    customerText: 'السلام عليكم',
    conversationFocus: {
      topics: ['contact'],
      evidenceRefs: ['contact-support'],
    },
    reply: 'وعليكم السلام، تواصل مع الدعم',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('OFF_TOPIC_CURRENT_TURN'), true);
});

test('explicit anaphoric material follow-up may use the focused product evidence', () => {
  const result = validate({
    customerText: 'وكم سعرها؟',
    conversationFocus: productFocus({ topics: ['price'] }),
    reply: 'سعرها ١٢٣٫٤٥ ريال سعودي',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('schemeless domains are claims and URL paths remain case-sensitive', () => {
  const schemelessExact = validate({
    customerText: 'أرسل رابط الراوتر',
    conversationFocus: productFocus({ topics: ['url'], variantId: null }),
    reply: 'رابط الراوتر merchant.invalid/ExactPath',
  });
  const wrongPathCase = validate({
    customerText: 'أرسل رابط الراوتر',
    conversationFocus: productFocus({ topics: ['url'], variantId: null }),
    reply: 'رابط الراوتر https://MERCHANT.INVALID/exactpath',
  });
  const invented = validate({
    customerText: 'أرسل رابط الراوتر',
    conversationFocus: productFocus({ topics: ['url'], variantId: null }),
    reply: 'رابط الراوتر evil.example/ExactPath',
  });

  assert.equal(schemelessExact.ok, true);
  assert.equal(schemelessExact.claims.some(claim => claim.type === 'url'), true);
  assert.equal(wrongPathCase.ok, false);
  assert.equal(codes(wrongPathCase).includes('UNSUPPORTED_URL'), true);
  assert.equal(invented.ok, false);
  assert.equal(codes(invented).includes('UNSUPPORTED_URL'), true);
});

test('a short code contained inside an authorized phone remains unsupported', () => {
  const result = validate({
    customerText: 'ما رمز التحقق؟',
    conversationFocus: {
      topics: ['number'],
      evidenceRefs: ['contact-support'],
    },
    reply: 'رمز التحقق ٥٠٠٠',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('UNSUPPORTED_NUMBER'), true);
});

test('common Arabic material forms and unknown material feature markers fail closed', () => {
  const cases = [
    {
      code: 'UNSUPPORTED_WARRANTY',
      reply: 'الراوتر مكفول',
      topic: 'warranty',
    },
    {
      code: 'UNSUPPORTED_AVAILABILITY',
      reply: 'الراوتر نافد',
      topic: 'availability',
    },
    {
      code: 'UNSUPPORTED_DISCOUNT',
      reply: 'على الراوتر عرض خاص',
      topic: 'discount',
    },
    {
      code: 'UNSUPPORTED_REFUND',
      reply: 'الترجيع فوري',
      topic: 'refund',
    },
    {
      code: 'UNSUPPORTED_COMMERCIAL_PROMISE',
      reply: 'الخدمة مضمونة أكيد',
      topic: 'promise',
    },
    {
      code: 'UNSUPPORTED_PRODUCT',
      reply: 'الراوتر يدعم ميزة إضافية',
      topic: 'product',
    },
  ];

  for (const currentCase of cases) {
    const result = validate({
      customerText: currentCase.reply,
      conversationFocus: productFocus({ topics: [currentCase.topic] }),
      reply: currentCase.reply,
    });

    assert.equal(result.ok, false, currentCase.reply);
    assert.equal(codes(result).includes(currentCase.code), true, currentCase.reply);
  }
});

test('the complete reported screenshot advice remains off-topic and unauthorized', () => {
  const result = validate({
    customerText: 'السلام عليكم',
    conversationFocus: {
      productId: 'product-router',
      variantId: 'variant-router-monthly',
      topics: ['contact', 'number'],
      evidenceRefs: ['product-router', 'contact-support'],
    },
    reply: 'وعليكم السلام، أعد إدخال الرقم وإذا استمرت المشكلة تواصل مع خدمة العملاء على 0593216744',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('OFF_TOPIC_CURRENT_TURN'), true);
  assert.equal(codes(result).includes('UNAUTHORIZED_CONTACT'), true);
});
