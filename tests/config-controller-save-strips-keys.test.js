'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeConfigForSave } = require('../src/controllers/config.controller');
const { canonicalConfig } = require('./helpers/canonical-config');

test('mergeConfigForSave strips API keys and preserves operational fields', () => {
  const merged = mergeConfigForSave({
    existing: canonicalConfig(),
    incoming: { model: 'y', openaiApiKey: 'attacker-tries-to-set' },
    isAdmin: false,
  });
  assert.equal(merged.model, 'y');
  assert.equal(merged.openaiApiKey, undefined);
});

test('legacy runtime fact writes are rejected instead of silently becoming a second truth', () => {
  assert.throws(
    () => mergeConfigForSave({
      existing: canonicalConfig(),
      incoming: { products: [{ name: 'legacy', price: '99' }] },
      isAdmin: true,
    }),
    error => error.code === 'NON_CANONICAL_CONFIG_WRITE',
  );
});

test('caller-forged policyVersion is rejected', () => {
  const candidate = canonicalConfig().merchantPolicy;
  candidate.policyVersion = 'sha256:forged';
  assert.throws(
    () => mergeConfigForSave({
      existing: {},
      incoming: { merchantPolicy: candidate },
      isAdmin: true,
    }),
    error => error.code === 'INVALID_MERCHANT_POLICY',
  );
});

test('valid merchant policy receives a derived policyVersion', () => {
  const merged = mergeConfigForSave({
    existing: {},
    incoming: canonicalConfig(),
    isAdmin: false,
  });
  assert.match(merged.merchantPolicy.policyVersion, /^sha256:/);
});
