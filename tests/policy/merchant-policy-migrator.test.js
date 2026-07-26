'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  migrateLegacyConfig,
} = require('../../src/policy/merchant-policy-migrator');
const {
  DEFAULT_CONFIG,
} = require('../../lib/constants');

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

test('treats DEFAULT_CONFIG merchantPolicy null as unmigrated and preserves null in rollback bytes', () => {
  const legacy = {
    ...DEFAULT_CONFIG,
    replyStyle: {
      tone: 'friendly',
      useDialect: false,
      useShortReplies: false,
      avoidPhrases: [],
    },
    products: [
      {
        id: 'product-null-default',
        name: 'Explicit price',
        price: '25 SAR',
      },
    ],
  };
  const beforeBytes = JSON.stringify(legacy);

  const result = migrateLegacyConfig(legacy);

  assert.equal(result.report.status, 'active');
  assert.equal(
    result.migratedConfig.merchantPolicy.catalog.products[0].id,
    'product-null-default',
  );
  assert.equal(JSON.stringify(result.rollbackConfig), beforeBytes);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.rollbackConfig, 'merchantPolicy'),
    true,
  );
  assert.equal(result.rollbackConfig.merchantPolicy, null);
});

test('preserves own magic legacy keys byte-equivalently without prototype injection', () => {
  const legacy = JSON.parse(
    '{"products":[],"__proto__":{"sentinel":"archived-not-inherited"}}',
  );
  const beforeBytes = JSON.stringify(legacy);

  const result = migrateLegacyConfig(legacy);

  assert.equal(JSON.stringify(result.rollbackConfig), beforeBytes);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.rollbackConfig, '__proto__'),
    true,
  );
  assert.equal(Object.getPrototypeOf(result.rollbackConfig), Object.prototype);
  assert.equal(result.rollbackConfig.sentinel, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.migratedConfig, '__proto__'),
    true,
  );
});

test('quarantines duplicate normalized products when any commercial fact differs', () => {
  const result = migrateLegacyConfig({
    products: [
      {
        id: 'product-one',
        name: 'Bundle',
        aliases: ['starter'],
        description: 'first description',
        price: '100 SAR',
      },
      {
        id: 'product-two',
        name: ' bundle ',
        aliases: ['different alias'],
        description: 'different description',
        price: '100 SAR',
      },
    ],
  });
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'needs_review');
  assert.deepEqual(policy.catalog.products, []);
  assert.equal(
    policy.migration.reviewItems.some(
      (item) => item.code === 'conflicting_product_facts',
    ),
    true,
  );
});

test('deduplicates only semantically identical normalized products', () => {
  const product = {
    id: 'product-identical',
    name: 'Bundle',
    aliases: ['starter'],
    description: 'same description',
    price: '100 SAR',
  };
  const result = migrateLegacyConfig({
    products: [product, { price: '100 SAR', ...product }],
  });
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'active');
  assert.equal(policy.catalog.products.length, 1);
  assert.equal(policy.catalog.products[0].id, 'product-identical');
});

test('quarantines duplicate contact IDs when contact facts differ', () => {
  const result = migrateLegacyConfig({
    routing: {
      contacts: [
        {
          id: 'contact-sales',
          name: 'Sales',
          phoneNumber: '+966500000000',
        },
        {
          id: 'contact-sales',
          name: 'Other sales',
          phoneNumber: '+966511111111',
        },
      ],
      rules: [],
      pauseAfterHandoff: false,
    },
  });
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'needs_review');
  assert.deepEqual(policy.routing.contacts, []);
  assert.equal(
    policy.migration.reviewItems.some(
      (item) => item.code === 'conflicting_contact_id',
    ),
    true,
  );
});

test('deduplicates only semantically identical contacts', () => {
  const contact = {
    id: 'contact-sales',
    name: 'Sales',
    phoneNumber: '+966500000000',
  };
  const result = migrateLegacyConfig({
    routing: {
      contacts: [contact, { phoneNumber: '+966500000000', ...contact }],
      rules: [],
      pauseAfterHandoff: false,
    },
  });
  const policy = result.migratedConfig.merchantPolicy;

  assert.equal(policy.status, 'active');
  assert.deepEqual(policy.routing.contacts, [contact]);
});

test('never invents major units or SAR for bare legacy prices', () => {
  const cases = [
    { name: 'number', price: 100 },
    { name: 'numeric string', price: '100' },
  ];

  const activated = [];
  const missingReview = [];
  for (const product of cases) {
    const result = migrateLegacyConfig({ products: [product] });
    const policy = result.migratedConfig.merchantPolicy;
    if (policy.status !== 'needs_review' || policy.catalog.products.length !== 0) {
      activated.push(product.name);
    }
    if (!policy.migration.reviewItems.some(
      (item) => item.code === 'ambiguous_product_price',
    )) {
      missingReview.push(product.name);
    }
  }

  assert.deepEqual(activated, []);
  assert.deepEqual(missingReview, []);
});

test('keeps invalid migration reports byte-equivalent across repeat migration', () => {
  const legacy = fixture('fully-structured-legacy.json');
  legacy.businessRules[0].id = 'product-coffee';

  const first = migrateLegacyConfig(legacy);
  const second = migrateLegacyConfig(first.migratedConfig);

  assert.equal(first.report.status, 'invalid');
  assert.deepEqual(second.report, first.report);
  assert.equal(
    JSON.stringify(second.migratedConfig),
    JSON.stringify(first.migratedConfig),
  );
  assert.equal(JSON.stringify(second.rollbackConfig), JSON.stringify(legacy));
});

test('versions a structurally valid existing policy and keeps the normalized output idempotent', () => {
  const generated = migrateLegacyConfig(
    fixture('fully-structured-legacy.json'),
  ).migratedConfig.merchantPolicy;
  const unversioned = JSON.parse(JSON.stringify(generated));
  delete unversioned.policyVersion;

  const first = migrateLegacyConfig({ merchantPolicy: unversioned });
  assert.match(
    first.migratedConfig.merchantPolicy.policyVersion,
    /^sha256:[a-f0-9]{64}$/,
  );

  const second = migrateLegacyConfig(first.migratedConfig);
  assert.equal(
    JSON.stringify(second.migratedConfig),
    JSON.stringify(first.migratedConfig),
  );
  assert.deepEqual(second.report, first.report);
});
