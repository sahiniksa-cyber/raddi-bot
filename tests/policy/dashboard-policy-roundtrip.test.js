'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeConfigForSave } = require('../../src/controllers/config.controller');
const { canonicalConfig } = require('../helpers/canonical-config');

test('dashboard round-trip preserves canonical policy and never posts legacy truth fields', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /nc\.merchantPolicy=config\.merchantPolicy/);
  assert.match(html, /delete nc\[k\]/);
  const config = canonicalConfig({ operational: { model: 'gpt-4o' } });
  const merged = mergeConfigForSave({
    existing: config,
    incoming: { merchantPolicy: config.merchantPolicy, model: 'gpt-4o-mini' },
    isAdmin: false,
  });
  assert.equal(merged.model, 'gpt-4o-mini');
  assert.equal(merged.merchantPolicy.status, 'active');
  assert.match(merged.merchantPolicy.policyVersion, /^sha256:/);
});
