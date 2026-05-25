'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskApiKey, normalizeProvider, ALLOWED_PROVIDERS } = require('../src/services/admin/admin-api-keys');

test('ALLOWED_PROVIDERS contains the four supported providers', () => {
  assert.deepEqual([...ALLOWED_PROVIDERS].sort(), ['anthropic', 'google', 'openai', 'openrouter']);
});

test('normalizeProvider lowercases and validates against allowlist', () => {
  assert.equal(normalizeProvider('OpenAI'), 'openai');
  assert.equal(normalizeProvider(' google '), 'google');
  assert.throws(() => normalizeProvider('foobar'), /provider/i);
  assert.throws(() => normalizeProvider(''), /provider/i);
});

test('maskApiKey returns null for empty input', () => {
  assert.equal(maskApiKey(''), null);
  assert.equal(maskApiKey(null), null);
  assert.equal(maskApiKey(undefined), null);
});

test('maskApiKey shows only last 4 characters for short keys', () => {
  assert.equal(maskApiKey('sk-12345678'), '••••5678');
});

test('maskApiKey preserves the provider prefix and last 4 characters for long keys', () => {
  assert.equal(maskApiKey('sk-proj-abcdefghijklmnop'), 'sk-proj-••••mnop');
  assert.equal(maskApiKey('AIzaSyAbCdEfGhIjKlMnOpQr'), 'AIza••••OpQr');
});
