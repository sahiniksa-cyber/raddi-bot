'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePolicyVersion,
  validateMerchantPolicy,
} = require('../../src/policy/merchant-policy-schema');

function policyWithKeyOrderA() {
  return {
    schemaVersion: 1,
    status: 'active',
    catalog: { products: [] },
    persona: {
      role: 'customer_service_agent',
      displayName: null,
      language: 'ar',
      dialect: 'neutral',
      tone: 'ودود',
      brevity: 'normal',
      formatting: { multiline: false, emoji: 'none' },
    },
    businessRules: [
      { id: 'rule-hours', topic: 'hours', statement: 'نعمل يومياً' },
    ],
    prohibitions: { words: [], phrases: [], claims: [], destinations: [] },
    routing: { contacts: [], rules: [], pauseAfterHandoff: false },
    instantReplies: [],
    migration: { legacyArchived: {}, reviewItems: [] },
  };
}

function policyWithKeyOrderB() {
  return {
    migration: { reviewItems: [], legacyArchived: {} },
    instantReplies: [],
    routing: { pauseAfterHandoff: false, rules: [], contacts: [] },
    prohibitions: { destinations: [], claims: [], phrases: [], words: [] },
    businessRules: [
      { statement: 'نعمل يومياً', topic: 'hours', id: 'rule-hours' },
    ],
    persona: {
      formatting: { emoji: 'none', multiline: false },
      brevity: 'normal',
      tone: 'ودود',
      dialect: 'neutral',
      language: 'ar',
      displayName: null,
      role: 'customer_service_agent',
    },
    catalog: { products: [] },
    status: 'active',
    schemaVersion: 1,
  };
}

test('canonical policy hashing is stable across object-key order', () => {
  assert.equal(
    derivePolicyVersion(policyWithKeyOrderA()),
    derivePolicyVersion(policyWithKeyOrderB()),
  );
});

test('changing a merchant fact changes policyVersion', () => {
  const before = policyWithKeyOrderA();
  const after = policyWithKeyOrderA();
  after.businessRules[0].statement = 'نعمل من الأحد إلى الخميس';

  assert.notEqual(derivePolicyVersion(before), derivePolicyVersion(after));
});

test('volatile migration timestamps do not change policyVersion', () => {
  const first = policyWithKeyOrderA();
  const second = policyWithKeyOrderA();
  first.migration.migratedAt = '2026-07-26T00:00:00.000Z';
  second.migration.migratedAt = '2026-07-27T00:00:00.000Z';

  assert.equal(derivePolicyVersion(first), derivePolicyVersion(second));
});

test('rejects a caller-forged policyVersion instead of trusting it', () => {
  const policy = policyWithKeyOrderA();
  policy.policyVersion = `sha256:${'0'.repeat(64)}`;

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(
    result.errors.find((error) => error.path === 'policyVersion'),
    { path: 'policyVersion', code: 'policy_version_mismatch' },
  );
});

test('accepts a stored policy only when its supplied version matches the derived version', () => {
  const policy = policyWithKeyOrderA();
  policy.policyVersion = derivePolicyVersion(policy);

  const result = validateMerchantPolicy(policy);
  assert.equal(result.ok, true);
  assert.equal(result.policyVersion, policy.policyVersion);
});
