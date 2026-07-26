'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compileMerchantPolicy,
} = require('../../src/policy/merchant-policy-compiler');

function policy() {
  return {
    schemaVersion: 1,
    status: 'active',
    catalog: {
      products: [
        {
          id: 'product-coffee',
          name: 'قهوة مختصة',
          aliases: [' قهوة ', 'COFFEE'],
          description: '',
          variants: [
            {
              id: 'variant-coffee-250g',
              name: '250 جرام',
              price: { amountMinor: 4500, currency: 'SAR' },
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
    businessRules: [
      { id: 'rule-delivery', topic: 'delivery', statement: 'خلال يومين' },
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
    instantReplies: [
      {
        id: 'reply-delivery',
        triggers: ['الشحن'],
        reply: 'خلال يومين',
        evidenceRefs: ['rule-delivery'],
      },
    ],
    migration: { legacyArchived: {}, reviewItems: [] },
  };
}

test('compiles immutable indexes for every required canonical lookup', () => {
  const result = compileMerchantPolicy(policy());

  assert.equal(result.ok, true);
  assert.equal(result.indexes.productsById['product-coffee'].name, 'قهوة مختصة');
  assert.equal(result.indexes.productsByAlias['قهوة'].id, 'product-coffee');
  assert.equal(result.indexes.productsByAlias.coffee.id, 'product-coffee');
  assert.equal(result.indexes.variantsById['variant-coffee-250g'].name, '250 جرام');
  assert.equal(result.indexes.businessRulesById['rule-delivery'].topic, 'delivery');
  assert.equal(result.indexes.contactsById['contact-support'].name, 'الدعم');
  assert.equal(result.indexes.instantRepliesById['reply-delivery'].reply, 'خلال يومين');
  assert.equal(Object.isFrozen(result.indexes), true);
  assert.equal(Object.isFrozen(result.indexes.productsById), true);
  assert.throws(() => {
    result.indexes.productsById.injected = {};
  }, TypeError);
});

test('compiles only the explicit argument and never a global merchant config', () => {
  global.merchantPolicy = {
    catalog: {
      products: [{ id: 'global-product', name: 'must-not-be-read' }],
    },
  };

  try {
    const result = compileMerchantPolicy(policy());
    assert.equal(result.ok, true);
    assert.equal(result.indexes.productsById['global-product'], undefined);
    assert.equal(result.indexes.productsById['product-coffee'].name, 'قهوة مختصة');
  } finally {
    delete global.merchantPolicy;
  }
});

test('returns a typed invalid result instead of partial indexes', () => {
  const invalid = policy();
  invalid.routing.rules.push({
    id: 'route-missing',
    topic: 'support',
    contactId: 'missing-contact',
  });

  const result = compileMerchantPolicy(invalid);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid');
  assert.equal(result.indexes, undefined);
  assert.equal(
    result.errors.some((error) => error.code === 'unknown_contact_ref'),
    true,
  );
});
