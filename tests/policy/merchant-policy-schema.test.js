'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
