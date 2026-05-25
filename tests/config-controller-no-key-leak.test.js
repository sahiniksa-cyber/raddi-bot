'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripApiKeysFromConfig } = require('../src/controllers/config.controller');

test('stripApiKeysFromConfig removes all four API key fields', () => {
  const input = {
    openaiApiKey: 'sk-1',
    googleApiKey: 'AIza-1',
    anthropicApiKey: 'sk-ant-1',
    openrouterApiKey: 'sk-or-1',
    model: 'google/gemini-2.0-flash',
    botInstructions: 'hello',
  };
  const out = stripApiKeysFromConfig(input);
  assert.equal(out.openaiApiKey, undefined);
  assert.equal(out.googleApiKey, undefined);
  assert.equal(out.anthropicApiKey, undefined);
  assert.equal(out.openrouterApiKey, undefined);
  assert.equal(out.model, 'google/gemini-2.0-flash', 'non-key fields preserved');
  assert.equal(out.botInstructions, 'hello');
});

test('stripApiKeysFromConfig returns a new object and does not mutate input', () => {
  const input = { openaiApiKey: 'sk-1', model: 'x' };
  const out = stripApiKeysFromConfig(input);
  assert.notEqual(out, input);
  assert.equal(input.openaiApiKey, 'sk-1', 'input unchanged');
});

test('stripApiKeysFromConfig handles null/undefined input', () => {
  assert.deepEqual(stripApiKeysFromConfig(null), {});
  assert.deepEqual(stripApiKeysFromConfig(undefined), {});
});
