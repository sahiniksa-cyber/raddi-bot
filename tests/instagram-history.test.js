'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildInstagramHistory } = require('../src/services/instagram/instagram-history');

test('returns chronological role/content pairs (DB returns DESC, we reverse)', async () => {
  const rows = [
    { role: 'assistant', content: 'B', direction: 'outbound', status: 'sent' },
    { role: 'user', content: 'A', direction: 'inbound', status: 'queued_for_ai' },
  ];
  const database = { query: async () => ({ rows }) };
  const hist = await buildInstagramHistory('conv1', 'u1', { memoryMessages: 50 }, { database });
  assert.deepStrictEqual(hist, [
    { role: 'user', content: 'A' },
    { role: 'assistant', content: 'B' },
  ]);
});

test('filters out empty content and coerces role to user/assistant', async () => {
  const rows = [
    { role: 'system', content: 'ignore-empty', direction: 'inbound' },
    { role: 'user', content: '', direction: 'inbound' },
    { role: 'user', content: 'hi', direction: 'inbound' },
  ];
  const database = { query: async () => ({ rows }) };
  const hist = await buildInstagramHistory('conv1', 'u1', {}, { database });
  assert.deepStrictEqual(hist, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'ignore-empty' },
  ]);
});

test('passes memoryMessages as the LIMIT param (default 50)', async () => {
  let captured;
  const database = { query: async (sql, params) => { captured = params; return { rows: [] }; } };
  await buildInstagramHistory('conv1', 'u1', {}, { database });
  assert.strictEqual(captured[2], 50);
  await buildInstagramHistory('conv1', 'u1', { memoryMessages: 20 }, { database });
  assert.strictEqual(captured[2], 20);
});
