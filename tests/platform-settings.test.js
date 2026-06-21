'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPlatformSetting, setPlatformSetting } = require('../src/services/platform/platform-settings');

function makeFakeDb() {
  const store = new Map();
  return {
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

test('get returns null when unset; set persists and round-trips', async () => {
  const db = makeFakeDb();
  assert.equal(await getPlatformSetting('quotaStopMessage', { database: db }), null);
  await setPlatformSetting('quotaStopMessage', { enabled: true, text: 'مرحبا' }, { database: db });
  assert.deepEqual(await getPlatformSetting('quotaStopMessage', { database: db }), { enabled: true, text: 'مرحبا' });
});
