'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEffectiveRemaining } = require('../src/services/billing/message-quota');

test('computeEffectiveRemaining returns the raw remaining when not expired', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() + 86400000).toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining returns 0 when expired and flag is set', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(result, 0);
});

test('computeEffectiveRemaining keeps remaining when expired but flag is false', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: false,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining handles null quota_expires_at as not-expired', () => {
  const result = computeEffectiveRemaining({
    messages_remaining: 2847,
    quota_expires_at: null,
    expire_resets_quota: true,
  });
  assert.equal(result, 2847);
});

test('computeEffectiveRemaining returns 0 for null/empty row', () => {
  assert.equal(computeEffectiveRemaining(null), 0);
  assert.equal(computeEffectiveRemaining({}), 0);
});
