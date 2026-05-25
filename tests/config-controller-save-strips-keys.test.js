'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeConfigForSave } = require('../src/controllers/config.controller');

test('mergeConfigForSave drops API key fields from incoming body when isAdmin=false', () => {
  const existing = { model: 'x', openaiApiKey: 'admin-set-earlier' };
  const incoming = { model: 'y', openaiApiKey: 'attacker-tries-to-set', botInstructions: 'hi' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: false });
  assert.equal(merged.model, 'y');
  assert.equal(merged.botInstructions, 'hi');
  assert.equal(merged.openaiApiKey, 'admin-set-earlier', 'existing key kept, incoming ignored');
});

test('mergeConfigForSave allows API keys when isAdmin=true', () => {
  const existing = { openaiApiKey: 'old' };
  const incoming = { openaiApiKey: 'new-admin-value' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: true });
  assert.equal(merged.openaiApiKey, 'new-admin-value');
});

test('mergeConfigForSave preserves non-key fields normally', () => {
  const merged = mergeConfigForSave({
    existing: { a: 1 },
    incoming: { b: 2 },
    isAdmin: false,
  });
  assert.deepEqual(merged, { a: 1, b: 2 });
});
