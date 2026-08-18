'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPlatformAlertPhone,
  setPlatformAlertPhone,
  getPlatformUrl,
  setPlatformUrl,
  normalizePhone,
  normalizeUrl,
} = require('../src/services/platform/platform-alert-config');

function makeFakeDb() {
  const store = new Map();
  return {
    store,
    query: async (sql, params) => {
      if (/INSERT INTO platform_settings/i.test(sql)) {
        store.set(params[0], typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]);
        return { rows: [] };
      }
      if (/SELECT value FROM platform_settings/i.test(sql)) {
        return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('normalizePhone strips everything except digits', () => {
  assert.equal(normalizePhone('+966 50 000 0001'), '966500000001');
  assert.equal(normalizePhone(null), '');
  assert.equal(normalizePhone('  '), '');
});

test('normalizeUrl trims but never invents a value', () => {
  assert.equal(normalizeUrl('  https://jwap.net  '), 'https://jwap.net');
  assert.equal(normalizeUrl(null), '');
  assert.equal(normalizeUrl(''), '');
});

test('platform alert phone: empty by default, round-trips normalized', async () => {
  const db = makeFakeDb();
  assert.equal(await getPlatformAlertPhone({ database: db }), '');
  await setPlatformAlertPhone('+966 50 123 4567', { database: db });
  assert.equal(await getPlatformAlertPhone({ database: db }), '966501234567');
});

test('platform url: empty by default, round-trips trimmed (no fallback, no invention)', async () => {
  const db = makeFakeDb();
  assert.equal(await getPlatformUrl({ database: db }), '');
  await setPlatformUrl('  https://jwap.net  ', { database: db });
  assert.equal(await getPlatformUrl({ database: db }), 'https://jwap.net');
});

test('accessors are tenant-agnostic platform-scoped keys (no user_id in the key space)', async () => {
  const db = makeFakeDb();
  await setPlatformAlertPhone('966500000001', { database: db });
  await setPlatformUrl('https://x.example', { database: db });
  // Exactly two global keys, both platform-scoped.
  assert.deepEqual([...db.store.keys()].sort(), ['platformAlertPhone', 'platformUrl']);
});
