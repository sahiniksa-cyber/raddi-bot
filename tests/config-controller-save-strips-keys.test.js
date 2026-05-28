'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeConfigForSave } = require('../src/controllers/config.controller');

// Security stance: API keys live in admin_api_keys (encrypted at rest).
// They MUST NOT appear in the persisted bot_configs.config JSONB. The
// merger therefore drops every API key field from the merged result —
// regardless of whether the caller is admin or not. The dashboard reads
// resolved keys via mergeApiKeys() in memory only.

test('mergeConfigForSave drops API key fields when isAdmin=false (existing keys are also stripped)', () => {
  const existing = { model: 'x', openaiApiKey: 'stale-leftover' };
  const incoming = { model: 'y', openaiApiKey: 'attacker-tries-to-set', botInstructions: 'hi' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: false });
  assert.equal(merged.model, 'y');
  assert.equal(merged.botInstructions, 'hi');
  assert.equal(merged.openaiApiKey, undefined, 'api key must never persist into bot_configs.config');
});

test('mergeConfigForSave still drops API keys when isAdmin=true (defense in depth)', () => {
  const existing = { openaiApiKey: 'old' };
  const incoming = { openaiApiKey: 'new-admin-value' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: true });
  assert.equal(merged.openaiApiKey, undefined);
});

test('mergeConfigForSave preserves non-key fields normally', () => {
  const merged = mergeConfigForSave({
    existing: { a: 1 },
    incoming: { b: 2 },
    isAdmin: false,
  });
  assert.deepEqual(merged, { a: 1, b: 2 });
});
