'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimGroupAction } = require('../src/services/whatsapp/group-action-dedup');

// A fake db that honors ON CONFLICT DO NOTHING against an in-memory key set.
function dedupDb() {
  const seen = new Set();
  return {
    seen,
    query: async (_sql, params) => {
      const key = `${params[0]}::${params[1]}`;
      if (seen.has(key)) return { rows: [] };        // conflict → no row
      seen.add(key);
      return { rows: [{ message_id: params[1] }] };   // newly inserted
    },
  };
}

test('claimGroupAction returns true the first time and false on a duplicate message id', async () => {
  const db = dedupDb();
  assert.equal(await claimGroupAction(db, 'u1', 'MSG_A', 'prompt_edit'), true);
  assert.equal(await claimGroupAction(db, 'u1', 'MSG_A', 'prompt_edit'), false);
  // A different id (or different user) is independent.
  assert.equal(await claimGroupAction(db, 'u1', 'MSG_B', 'prompt_edit'), true);
  assert.equal(await claimGroupAction(db, 'u2', 'MSG_A', 'prompt_edit'), true);
});

test('claimGroupAction allows (true) when it cannot dedup: missing id or user', async () => {
  const db = dedupDb();
  assert.equal(await claimGroupAction(db, 'u1', null), true);
  assert.equal(await claimGroupAction(db, null, 'MSG_A'), true);
});

test('claimGroupAction fails OPEN (true) on a db error — never blocks a real action', async () => {
  const db = { query: async () => { throw new Error('db down'); } };
  assert.equal(await claimGroupAction(db, 'u1', 'MSG_A', 'prompt_edit'), true);
});
