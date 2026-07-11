'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { logInstagram } = require('../src/services/instagram/instagram-logs');

test('logInstagram inserts a row with the given fields', async () => {
  let captured = null;
  const okDb = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
  await logInstagram('u1', 'error', 'send', { message: 'boom' }, { database: okDb });
  assert.ok(captured.sql.includes('INSERT INTO instagram_logs'));
  assert.strictEqual(captured.params[0], 'u1');
  assert.strictEqual(captured.params[1], 'error');
  assert.strictEqual(captured.params[2], 'send');
  assert.strictEqual(captured.params[3], JSON.stringify({ message: 'boom' }));
});

test('logInstagram never throws on db error (isolation invariant)', async () => {
  const badDb = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(() => logInstagram('u1', 'info', 'x', {}, { database: badDb }));
});

test('logInstagram tolerates missing user/detail', async () => {
  let captured = null;
  const okDb = { query: async (sql, params) => { captured = params; return { rows: [] }; } };
  await logInstagram(null, undefined, undefined, undefined, { database: okDb });
  assert.strictEqual(captured[0], null);
  assert.strictEqual(captured[1], 'info');
});
