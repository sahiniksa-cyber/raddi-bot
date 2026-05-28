'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeConfigForSave,
  stripApiKeysFromConfig,
} = require('../src/controllers/config.controller');
const {
  stripApiKeysFromConfigForStorage,
  mergeApiKeys,
} = require('../src/services/config/api-keys-resolver');

test('mergeConfigForSave strips API keys even when admin sets them', () => {
  const merged = mergeConfigForSave({
    existing: { model: 'x' },
    incoming: {
      openaiApiKey: 'sk-LEAK-attempt-very-long-key-1234567890',
      googleApiKey: 'AIzaLeakAttemptLong1234567890abcdef',
      anthropicApiKey: 'sk-ant-leak-attempt',
      openrouterApiKey: 'sk-or-leak-attempt',
      botInstructions: 'hi',
    },
    isAdmin: true,
  });

  const serialized = JSON.stringify(merged);
  assert.ok(!serialized.includes('sk-LEAK'), 'openai leaked into persisted config');
  assert.ok(!serialized.includes('AIzaLeakAttempt'), 'google leaked into persisted config');
  assert.ok(!serialized.includes('sk-ant-leak'), 'anthropic leaked into persisted config');
  assert.ok(!serialized.includes('sk-or-leak'), 'openrouter leaked into persisted config');

  // Non-key fields preserved.
  assert.equal(merged.botInstructions, 'hi');
});

test('mergeConfigForSave drops API keys silently for non-admin', () => {
  const merged = mergeConfigForSave({
    existing: { openaiApiKey: 'old' }, // stale field — should be removed too
    incoming: { openaiApiKey: 'sk-attacker', other: 'ok' },
    isAdmin: false,
  });
  assert.equal(merged.openaiApiKey, undefined);
  assert.equal(merged.other, 'ok');
});

test('stripApiKeysFromConfigForStorage removes all four API key fields', () => {
  const out = stripApiKeysFromConfigForStorage({
    openaiApiKey: 'a',
    googleApiKey: 'b',
    anthropicApiKey: 'c',
    openrouterApiKey: 'd',
    model: 'preserved',
  });
  assert.equal(out.openaiApiKey, undefined);
  assert.equal(out.googleApiKey, undefined);
  assert.equal(out.anthropicApiKey, undefined);
  assert.equal(out.openrouterApiKey, undefined);
  assert.equal(out.model, 'preserved');
});

test('stripApiKeysFromConfig (legacy export) matches the storage helper', () => {
  const input = { openaiApiKey: 'x', y: 1 };
  assert.deepEqual(stripApiKeysFromConfig(input), { y: 1 });
});

test('mergeApiKeys result is flagged as in-memory only and never persisted by mergeConfigForSave', () => {
  // Simulate what RuntimeBot does: merge admin keys, then pass through save.
  const inMemory = mergeApiKeys(
    { model: 'g/gemini' },
    { openai: 'admin-set', google: 'admin-google', anthropic: '', openrouter: '' },
  );
  // The in-memory copy DOES have the merged keys (that's the whole point).
  assert.equal(inMemory.openaiApiKey, 'admin-set');
  assert.equal(inMemory.googleApiKey, 'admin-google');

  // But the moment we try to persist it, the keys are removed.
  const persisted = mergeConfigForSave({
    existing: {},
    incoming: inMemory,
    isAdmin: false,
  });
  assert.equal(persisted.openaiApiKey, undefined);
  assert.equal(persisted.googleApiKey, undefined);
  assert.equal(persisted.model, 'g/gemini');
});
