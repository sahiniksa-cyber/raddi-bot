'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEffectiveRemaining, checkMessageQuota } = require('../src/services/billing/message-quota');

function fakeDb(rows) {
  return { query: async () => ({ rows }) };
}

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

test('checkMessageQuota returns canReply when remaining > 0 and not expired', async () => {
  const database = fakeDb([{
    messages_remaining: 2847,
    quota_expires_at: new Date(Date.now() + 86400000).toISOString(),
    expire_resets_quota: true,
  }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, true);
  assert.equal(result.remaining, 2847);
});

test('checkMessageQuota refuses when no account exists', async () => {
  const result = await checkMessageQuota('user-1', { database: fakeDb([]) });
  assert.deepEqual(result, { canReply: false, remaining: 0, reason: 'no_account' });
});

test('checkMessageQuota refuses when remaining is zero', async () => {
  const database = fakeDb([{ messages_remaining: 0, quota_expires_at: null, expire_resets_quota: true }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'empty');
});

test('checkMessageQuota refuses when expired and flag is set', async () => {
  const database = fakeDb([{
    messages_remaining: 100,
    quota_expires_at: new Date(Date.now() - 86400000).toISOString(),
    expire_resets_quota: true,
  }]);
  const result = await checkMessageQuota('user-1', { database });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'expired');
});

const { decrementMessageQuota } = require('../src/services/billing/message-quota');

function fakeDbCapture(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test('decrementMessageQuota returns success and new remaining on update', async () => {
  const database = fakeDbCapture([{ messages_remaining: 2846 }]);
  const result = await decrementMessageQuota('user-1', { database });
  assert.equal(result.success, true);
  assert.equal(result.remaining, 2846);
  assert.match(database.calls[0].sql, /UPDATE billing_accounts/);
  assert.match(database.calls[0].sql, /messages_remaining = messages_remaining - 1/);
  assert.match(database.calls[0].sql, /WHERE user_id = \$1/);
  assert.match(database.calls[0].sql, /messages_remaining > 0/);
  assert.match(database.calls[0].sql, /expire_resets_quota/);
  assert.match(database.calls[0].sql, /quota_expires_at > NOW\(\)/);
});

test('decrementMessageQuota returns failure when UPDATE matches no rows', async () => {
  const database = fakeDbCapture([]);
  const result = await decrementMessageQuota('user-1', { database });
  assert.deepEqual(result, { success: false });
});
