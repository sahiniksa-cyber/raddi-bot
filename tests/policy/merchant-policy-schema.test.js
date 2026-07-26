'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePolicyVersion,
  validateMerchantPolicy,
} = require('../../src/policy/merchant-policy-schema');
const {
  PLATFORM_REPLY_POLICY,
} = require('../../src/policy/platform-reply-policy');
const {
  DEFAULT_CONFIG,
} = require('../../lib/constants');

function validPolicy() {
  return {
    schemaVersion: 1,
    status: 'active',
    catalog: {
      products: [
        {
          id: 'product-coffee',
          name: 'قهوة مختصة',
          aliases: ['قهوة'],
          description: 'بن محمّص',
          variants: [
            {
              id: 'variant-coffee-250g',
              name: '250 جرام',
              price: { amountMinor: 4500, currency: 'SAR' },
              duration: null,
              availability: 'available',
              attributes: {},
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
        id: 'rule-delivery',
        topic: 'delivery',
        statement: 'التوصيل خلال يومين',
      },
    ],
    prohibitions: {
      words: [],
      phrases: [],
      claims: [],
      destinations: [],
    },
    routing: {
      contacts: [
        {
          id: 'contact-support',
          name: 'الدعم',
          phoneNumber: '+966500000000',
        },
      ],
      rules: [
        {
          id: 'route-support',
          topic: 'support',
          contactId: 'contact-support',
        },
      ],
      pauseAfterHandoff: false,
    },
    instantReplies: [
      {
        id: 'reply-delivery',
        triggers: ['الشحن'],
        reply: 'التوصيل خلال يومين',
        evidenceRefs: ['rule-delivery'],
      },
    ],
    migration: {
      legacyArchived: {},
      reviewItems: [],
    },
  };
}

function hasError(result, path, code) {
  return result.errors.some((error) => error.path === path && error.code === code);
}

test('rejects a policy missing any required section', () => {
  const required = [
    'schemaVersion',
    'status',
    'catalog',
    'persona',
    'businessRules',
    'prohibitions',
    'routing',
    'instantReplies',
    'migration',
  ];

  for (const section of required) {
    const policy = validPolicy();
    delete policy[section];
    const result = validateMerchantPolicy(policy);

    assert.equal(result.ok, false, `${section} must be required`);
    assert.equal(result.status, 'invalid');
    assert.equal(hasError(result, section, 'required'), true);
  }
});

test('accepts only active, needs_review, or invalid as status', () => {
  for (const status of ['active', 'needs_review', 'invalid']) {
    const policy = validPolicy();
    policy.status = status;
    assert.equal(validateMerchantPolicy(policy).ok, true, `${status} must be accepted`);
  }

  const policy = validPolicy();
  policy.status = 'draft';
  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(hasError(result, 'status', 'invalid_enum'), true);
});

test('requires integer minor-unit prices with an explicit ISO currency', () => {
  const fractional = validPolicy();
  fractional.catalog.products[0].variants[0].price.amountMinor = 45.5;
  const fractionalResult = validateMerchantPolicy(fractional);
  assert.equal(fractionalResult.ok, false);
  assert.equal(
    hasError(
      fractionalResult,
      'catalog.products[0].variants[0].price.amountMinor',
      'invalid_integer',
    ),
    true,
  );

  const missingCurrency = validPolicy();
  delete missingCurrency.catalog.products[0].variants[0].price.currency;
  const missingCurrencyResult = validateMerchantPolicy(missingCurrency);
  assert.equal(missingCurrencyResult.ok, false);
  assert.equal(
    hasError(
      missingCurrencyResult,
      'catalog.products[0].variants[0].price.currency',
      'required',
    ),
    true,
  );

  const invalidCurrency = validPolicy();
  invalidCurrency.catalog.products[0].variants[0].price.currency = 'riyal';
  const invalidCurrencyResult = validateMerchantPolicy(invalidCurrency);
  assert.equal(invalidCurrencyResult.ok, false);
  assert.equal(
    hasError(
      invalidCurrencyResult,
      'catalog.products[0].variants[0].price.currency',
      'invalid_currency',
    ),
    true,
  );
});

test('rejects duplicate stable IDs across canonical policy entities', () => {
  const policy = validPolicy();
  policy.businessRules[0].id = 'product-coffee';

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(hasError(result, 'businessRules[0].id', 'duplicate_id'), true);
});

test('instant reply evidence references must resolve to products, business rules, or contacts', () => {
  const policy = validPolicy();
  policy.instantReplies[0].evidenceRefs = ['missing-evidence'];

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(
    hasError(result, 'instantReplies[0].evidenceRefs[0]', 'unknown_evidence_ref'),
    true,
  );
});

test('routing rules must reference an existing contact', () => {
  const policy = validPolicy();
  policy.routing.rules[0].contactId = 'contact-missing';

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(
    hasError(result, 'routing.rules[0].contactId', 'unknown_contact_ref'),
    true,
  );
});

test('returns a deeply immutable validated policy and derived version', () => {
  const result = validateMerchantPolicy(validPolicy());

  assert.equal(result.ok, true);
  assert.match(result.policyVersion, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.policy.policyVersion, result.policyVersion);
  assert.equal(Object.isFrozen(result.policy), true);
  assert.equal(Object.isFrozen(result.policy.catalog.products[0]), true);
  assert.throws(() => {
    result.policy.catalog.products[0].name = 'متغير';
  }, TypeError);
});

test('platform reply invariants are code-owned, versioned, and immutable', () => {
  assert.equal(
    PLATFORM_REPLY_POLICY.policyVersion,
    require('../../src/policy/merchant-policy-schema')
      .derivePolicyVersion(PLATFORM_REPLY_POLICY),
  );
  assert.equal(
    PLATFORM_REPLY_POLICY.invariants.merchantFactsComeOnlyFromCanonicalPolicy,
    true,
  );
  assert.equal(Object.isFrozen(PLATFORM_REPLY_POLICY), true);
  assert.equal(Object.isFrozen(PLATFORM_REPLY_POLICY.invariants), true);
});

test('default config contains no fabricated canonical merchant facts', () => {
  assert.equal(DEFAULT_CONFIG.merchantPolicy, null);
  assert.equal(validateMerchantPolicy(DEFAULT_CONFIG.merchantPolicy).ok, false);
});

test('canonical hashing preserves an own __proto__ key instead of colliding with clean JSON', () => {
  const clean = validPolicy();
  const poisoned = validPolicy();
  poisoned.catalog.products[0].attributes = JSON.parse(
    '{"__proto__":{"commercialFact":"forged"}}',
  );

  assert.notEqual(derivePolicyVersion(poisoned), derivePolicyVersion(clean));
});

test('rejects magic keys before returning a policy', () => {
  const magic = validPolicy();
  magic.catalog.products[0].attributes = JSON.parse(
    '{"__proto__":{"commercialFact":"forged"}}',
  );
  const magicResult = validateMerchantPolicy(magic);
  assert.equal(magicResult.ok, false);
  assert.equal(
    hasError(
      magicResult,
      'catalog.products[0].attributes.__proto__',
      'forbidden_key',
    ),
    true,
  );
});

test('rejects unsupported object prototypes before returning a policy', () => {
  const unsupported = validPolicy();
  unsupported.persona.formatting = Object.create({ inherited: 'not-json' });
  const unsupportedResult = validateMerchantPolicy(unsupported);
  assert.equal(unsupportedResult.ok, false);
  assert.equal(
    hasError(unsupportedResult, 'persona.formatting', 'invalid_prototype'),
    true,
  );
});

test('deep-freezes safe nested extension values', () => {
  const policy = validPolicy();
  policy.catalog.products[0].attributes = {
    package: { dimensions: { width: 12 } },
  };

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, true);
  assert.equal(
    Object.isFrozen(
      result.policy.catalog.products[0].attributes.package.dimensions,
    ),
    true,
  );
  assert.throws(() => {
    result.policy.catalog.products[0].attributes.package.dimensions.width = 99;
  }, TypeError);
});

test('rejects unexpected keys at every fact-bearing policy level', () => {
  const cases = [
    ['root', 'botInstructions', (policy) => { policy.botInstructions = 'price 10'; }],
    ['catalog', 'catalog.source', (policy) => { policy.catalog.source = 'legacy'; }],
    [
      'product',
      'catalog.products[0].legacyPrice',
      (policy) => { policy.catalog.products[0].legacyPrice = '45'; },
    ],
    [
      'variant',
      'catalog.products[0].variants[0].prose',
      (policy) => { policy.catalog.products[0].variants[0].prose = 'guess'; },
    ],
    [
      'price',
      'catalog.products[0].variants[0].price.display',
      (policy) => { policy.catalog.products[0].variants[0].price.display = '45'; },
    ],
    ['persona', 'persona.instructions', (policy) => { policy.persona.instructions = 'sell'; }],
    [
      'business rule',
      'businessRules[0].confidence',
      (policy) => { policy.businessRules[0].confidence = 0.7; },
    ],
    [
      'prohibitions',
      'prohibitions.notes',
      (policy) => { policy.prohibitions.notes = 'free prose'; },
    ],
    ['routing', 'routing.ownerNumber', (policy) => { policy.routing.ownerNumber = '0500'; }],
    [
      'contact',
      'routing.contacts[0].instructions',
      (policy) => { policy.routing.contacts[0].instructions = 'guess'; },
    ],
    [
      'routing rule',
      'routing.rules[0].fallback',
      (policy) => { policy.routing.rules[0].fallback = 'owner'; },
    ],
    [
      'instant reply',
      'instantReplies[0].modelPrompt',
      (policy) => { policy.instantReplies[0].modelPrompt = 'invent'; },
    ],
    ['migration', 'migration.notes', (policy) => { policy.migration.notes = 'free prose'; }],
    [
      'review item',
      'migration.reviewItems[0].text',
      (policy) => {
        policy.status = 'needs_review';
        policy.migration.reviewItems.push({ path: 'legacy', code: 'review', text: 'guess' });
      },
    ],
  ];

  const missed = [];
  for (const [label, path, mutate] of cases) {
    const policy = validPolicy();
    mutate(policy);
    const result = validateMerchantPolicy(policy);
    if (result.ok || !hasError(result, path, 'unexpected_key')) missed.push(label);
  }

  assert.deepEqual(missed, []);
});

test('requires safe integer minor units', () => {
  const policy = validPolicy();
  policy.catalog.products[0].variants[0].price.amountMinor =
    Number.MAX_SAFE_INTEGER + 1;

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(
    hasError(
      result,
      'catalog.products[0].variants[0].price.amountMinor',
      'invalid_integer',
    ),
    true,
  );
});

test('rejects syntactically plausible but unsupported currencies', () => {
  const policy = validPolicy();
  policy.catalog.products[0].variants[0].price.currency = 'ZZZ';

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(
    hasError(
      result,
      'catalog.products[0].variants[0].price.currency',
      'invalid_currency',
    ),
    true,
  );
});

test('accepts a canonical policy price denominated in EUR', () => {
  const policy = validPolicy();
  policy.catalog.products[0].variants[0].price = {
    amountMinor: 4599,
    currency: 'EUR',
  };

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.policy.catalog.products[0].variants[0].price,
    { amountMinor: 4599, currency: 'EUR' },
  );
});
