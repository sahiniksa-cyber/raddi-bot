'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeApiKeys } = require('../src/services/config/api-keys-resolver');

test('mergeApiKeys uses admin keys when customer has none', () => {
  const merged = mergeApiKeys(
    { model: 'google/gemini-2.0-flash' },
    { openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.googleApiKey, 'admin-google');
  assert.equal(merged.openaiApiKey, 'admin-openai');
  assert.equal(merged.anthropicApiKey, '');
  assert.equal(merged.openrouterApiKey, '');
  assert.equal(merged.model, 'google/gemini-2.0-flash', 'preserves other config fields');
});

test('mergeApiKeys lets a non-empty customer key override the admin key', () => {
  const merged = mergeApiKeys(
    { openaiApiKey: 'customer-openai' },
    { openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.openaiApiKey, 'customer-openai');
  assert.equal(merged.googleApiKey, 'admin-google');
});

test('mergeApiKeys treats whitespace-only customer keys as empty', () => {
  const merged = mergeApiKeys(
    { openaiApiKey: '   ' },
    { openai: 'admin-openai', google: '', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.openaiApiKey, 'admin-openai');
});

test('mergeApiKeys returns a new object and does not mutate input', () => {
  const customer = { openaiApiKey: 'c-key', model: 'x' };
  const admin = { openai: 'a-key', google: '', anthropic: '', openrouter: '' };
  const merged = mergeApiKeys(customer, admin);
  assert.notEqual(merged, customer);
  assert.equal(customer.googleApiKey, undefined, 'customer object is untouched');
});

test('mergeApiKeys handles missing admin keys gracefully', () => {
  const merged = mergeApiKeys({ openaiApiKey: 'c' }, null);
  assert.equal(merged.openaiApiKey, 'c');
  assert.equal(merged.googleApiKey, '');
});

test('mergeApiKeys handles missing customer config gracefully', () => {
  const merged = mergeApiKeys(null, { openai: 'a', google: 'b', anthropic: '', openrouter: '' });
  assert.equal(merged.openaiApiKey, 'a');
  assert.equal(merged.googleApiKey, 'b');
});
