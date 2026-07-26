'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  migrateLegacyConfig,
} = require('../../src/policy/merchant-policy-migrator');

function fixture(name) {
  const file = path.join(__dirname, '..', 'fixtures', 'policy', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('maps fully structured legacy products, persona, prohibitions, and routing', () => {
  const legacy = fixture('fully-structured-legacy.json');
  const result = migrateLegacyConfig(legacy);
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(result.report.status, 'active');
  assert.equal(policy.status, 'active');
  assert.deepEqual(policy.catalog.products, [
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
  ]);
  assert.deepEqual(policy.persona, {
    role: 'customer_service_agent',
    displayName: null,
    language: 'ar',
    dialect: 'saudi',
    tone: 'ودود',
    brevity: 'concise',
    formatting: { multiline: false },
  });
  assert.deepEqual(policy.prohibitions, {
    words: ['مستحيل'],
    phrases: ['لا أقدر'],
    claims: [],
    destinations: [],
  });
  assert.deepEqual(policy.routing, {
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
    pauseAfterHandoff: true,
  });
  assert.match(result.report.legacyHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(policy.policyVersion, /^sha256:[a-f0-9]{64}$/);
});

test('maps autoReplyKeywords exactly and adds only deterministic evidence references', () => {
  const result = migrateLegacyConfig(fixture('fully-structured-legacy.json'));
  const replies = result.migratedConfig.merchantPolicy.instantReplies;

  assert.deepEqual(
    replies.map(({ triggers, reply, evidenceRefs }) => ({ triggers, reply, evidenceRefs })),
    [
      {
        triggers: ['الشحن'],
        reply: 'التوصيل خلال يومين',
        evidenceRefs: ['rule-delivery'],
      },
      {
        triggers: ['قهوة'],
        reply: 'قهوة مختصة',
        evidenceRefs: ['product-coffee'],
      },
    ],
  );
});

test('stable instant-reply IDs do not depend on legacy object-key order', () => {
  const first = migrateLegacyConfig({
    autoReplyKeywords: {
      shipping: 'two days',
      returns: 'seven days',
    },
  });
  const second = migrateLegacyConfig({
    autoReplyKeywords: {
      returns: 'seven days',
      shipping: 'two days',
    },
  });
  const idsByTrigger = (result) => Object.fromEntries(
    result.migratedConfig.merchantPolicy.instantReplies
      .map((reply) => [reply.triggers[0], reply.id]),
  );

  assert.deepEqual(idsByTrigger(first), idsByTrigger(second));
});

test('botInstructions with price and contact-looking text remains archived and never populates active facts or routing', () => {
  const legacy = fixture('bot-instructions-numeric.json');
  const result = migrateLegacyConfig(legacy);
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'needs_review');
  assert.deepEqual(policy.catalog.products, []);
  assert.deepEqual(policy.businessRules, []);
  assert.deepEqual(policy.routing.contacts, []);
  assert.deepEqual(policy.routing.rules, []);
  assert.equal(
    policy.migration.legacyArchived.botInstructions,
    'سعر الباقة 199 ريال، وللتواصل واتساب 0501234567',
  );
  assert.equal(
    policy.migration.reviewItems.some((item) => item.code === 'untyped_bot_instructions'),
    true,
  );
});

test('conflicting structured product prices are review items and are never activated', () => {
  const result = migrateLegacyConfig(fixture('conflicting-product-prices.json'));
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'needs_review');
  assert.deepEqual(policy.catalog.products, []);
  assert.equal(
    policy.migration.reviewItems.some((item) => item.code === 'conflicting_product_prices'),
    true,
  );
  assert.deepEqual(
    policy.migration.legacyArchived.products,
    fixture('conflicting-product-prices.json').products,
  );
});

test('ambiguous structured contact numbers and free-form routing rules stay review-only', () => {
  const result = migrateLegacyConfig(fixture('ambiguous-contact-numbers.json'));
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'needs_review');
  assert.deepEqual(policy.routing.contacts, []);
  assert.deepEqual(policy.routing.rules, []);
  assert.equal(policy.routing.pauseAfterHandoff, true);
  assert.equal(
    policy.migration.reviewItems.some((item) => item.code === 'ambiguous_contact_number'),
    true,
  );
  assert.equal(
    policy.migration.reviewItems.some((item) => item.code === 'untyped_routing_condition'),
    true,
  );
});

test('migration is pure, byte-equivalent for rollback, and idempotent on repeat', () => {
  const legacy = fixture('fully-structured-legacy.json');
  const beforeBytes = JSON.stringify(legacy);

  const first = migrateLegacyConfig(legacy);
  const second = migrateLegacyConfig(first.migratedConfig);

  assert.equal(JSON.stringify(legacy), beforeBytes, 'input config must not be mutated');
  assert.equal(JSON.stringify(first.rollbackConfig), beforeBytes);
  assert.equal(
    JSON.stringify(second.migratedConfig),
    JSON.stringify(first.migratedConfig),
  );
  assert.equal(JSON.stringify(second.rollbackConfig), beforeBytes);
  assert.deepEqual(second.report, first.report);
});
