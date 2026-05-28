'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkMessageQuota, decrementMessageQuota } = require('../src/services/billing/message-quota');

function fakeDb(rows) {
  return {
    rows,
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      // For SELECT, return the configured rows.
      if (/^\s*SELECT/i.test(sql)) return { rows: this.rows };
      // For UPDATE (decrement), simulate success when first row has remaining > 0.
      if (/UPDATE\s+billing_accounts/i.test(sql)) {
        const row = this.rows[0];
        if (!row || row.messages_remaining <= 0) return { rows: [] };
        row.messages_remaining -= 1;
        return { rows: [{ messages_remaining: row.messages_remaining }] };
      }
      return { rows: [] };
    },
  };
}

test('checkMessageQuota returns canReply=false when account is missing', async () => {
  const db = fakeDb([]);
  const result = await checkMessageQuota('user-1', { database: db });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'no_account');
});

test('checkMessageQuota returns canReply=false when remaining is 0', async () => {
  const db = fakeDb([{ messages_remaining: 0, quota_expires_at: null, expire_resets_quota: false }]);
  const result = await checkMessageQuota('user-1', { database: db });
  assert.equal(result.canReply, false);
  assert.equal(result.reason, 'empty');
});

test('checkMessageQuota returns canReply=true and remaining when in good standing', async () => {
  const db = fakeDb([{ messages_remaining: 42, quota_expires_at: null, expire_resets_quota: false }]);
  const result = await checkMessageQuota('user-1', { database: db });
  assert.equal(result.canReply, true);
  assert.equal(result.remaining, 42);
});

test('decrementMessageQuota debits one message on success', async () => {
  const db = fakeDb([{ messages_remaining: 5, quota_expires_at: null, expire_resets_quota: false }]);
  const result = await decrementMessageQuota('user-1', { database: db });
  assert.equal(result.success, true);
  assert.equal(result.remaining, 4);
});

test('decrementMessageQuota returns success=false when remaining is 0', async () => {
  const db = fakeDb([{ messages_remaining: 0, quota_expires_at: null, expire_resets_quota: false }]);
  const result = await decrementMessageQuota('user-1', { database: db });
  assert.equal(result.success, false);
});
