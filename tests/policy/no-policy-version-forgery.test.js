'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeConfigForSave } = require('../../src/controllers/config.controller');
const { canonicalConfig } = require('../helpers/canonical-config');

test('configuration writer rejects a caller-supplied forged policy version', () => {
  const policy = canonicalConfig().merchantPolicy;
  policy.policyVersion = 'sha256:attacker';
  assert.throws(
    () => mergeConfigForSave({
      existing: {},
      incoming: { merchantPolicy: policy },
      isAdmin: true,
    }),
    error => error.code === 'INVALID_MERCHANT_POLICY',
  );
});
