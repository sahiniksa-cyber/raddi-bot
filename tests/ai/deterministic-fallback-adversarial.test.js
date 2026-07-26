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
          id: 'product-router',
          name: 'راوتر برو',
          aliases: ['الراوتر'],
          description: '',
          variants: [
            {
              id: 'variant-router',
              name: 'الأساسي',
              price: { amountMinor: 12345, currency: 'SAR' },
              duration: null,
              availability: null,
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
    customerText: 'السلام عليكم',
    conversationFocus: { topics: [], evidenceRefs: [] },
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  });
}

test('fallback never renders a contact from forged caller indexes', () => {
  const canonical = compiledPolicy();
  const fakeContact = {
    id: 'contact-forged',
    name: 'جهة مزيفة',
    phoneNumber: '+966593216744',
  };
  const forged = {
    ...canonical,
    indexes: {
      ...canonical.indexes,
      contactsById: {
        ...canonical.indexes.contactsById,
        [fakeContact.id]: fakeContact,
      },
    },
  };

  const result = build({
    customerText: 'كيف أتواصل؟',
    conversationFocus: {
      topics: ['contact'],
      evidenceRefs: ['contact-forged'],
    },
    compiledPolicy: forged,
    evidenceRef: 'contact-forged',
  });

  assert.equal(result.templateId, 'clarify');
  assert.doesNotMatch(result.reply, /[0-9٠-٩۰-۹]/u);
  assert.equal(result.validation.ok, false);
});

test('fallback rejects a legitimate contact when caller platform policy is arbitrary', () => {
  const result = build({
    customerText: 'كيف أتواصل؟',
    conversationFocus: {
      topics: ['contact'],
      evidenceRefs: ['contact-support'],
    },
    evidenceRef: 'contact-support',
    platformPolicy: {
      policyVersion: 'sha256:caller-controlled',
      invariants: {
        automatedRepliesRequireActiveMerchantPolicy: true,
        merchantFactsComeOnlyFromCanonicalPolicy: true,
        probabilisticComponentsHaveNoSendAuthority: true,
      },
    },
  });

  assert.equal(result.templateId, 'clarify');
  assert.doesNotMatch(result.reply, /[0-9٠-٩۰-۹]/u);
  assert.equal(result.validation.ok, false);
});

test('stale product focus cannot render a product fallback for a greeting', () => {
  const result = build({
    customerText: 'السلام عليكم',
    conversationFocus: {
      productId: 'product-router',
      topics: ['product'],
      evidenceRefs: ['product-router'],
    },
    evidenceRef: 'product-router',
  });

  assert.equal(result.templateId, 'clarify');
  assert.equal(result.reply.includes('راوتر برو'), false);
  assert.equal(result.validation.ok, true);
});
