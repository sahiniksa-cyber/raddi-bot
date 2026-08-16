'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { saveInstagramConfig } = require('../src/services/instagram/instagram-config');

// P4 (Instagram): the dashboard now sends a PARTIAL config patch. saveInstagramConfig
// must MERGE it into the existing stored config, not replace the whole thing —
// otherwise a small patch wipes the merchant's other Instagram settings.
test('INSTAGRAM PATCH SAFETY: {A,B,C} + patch{B} → {A,newB,C}', async () => {
  let stored = { storeName: 'A', welcomeMessage: 'B', memoryMessages: 30 }; // C=memoryMessages
  const database = {
    query: async (sql, params) => {
      if (/SELECT\s+config\s+FROM\s+instagram_ai_settings/i.test(sql) || (/SELECT[\s\S]*config[\s\S]*instagram_ai_settings/i.test(sql))) {
        return { rows: [{ config: stored }] };
      }
      if (/INSERT INTO instagram_ai_settings/i.test(sql)) {
        stored = JSON.parse(params[2]); // the merged config written
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  await saveInstagramConfig('u1', { enabled: true, config: { welcomeMessage: 'newB' } }, { database });

  assert.equal(stored.storeName, 'A', 'A preserved');
  assert.equal(stored.welcomeMessage, 'newB', 'B updated');
  assert.equal(stored.memoryMessages, 30, 'C preserved');
});

test('INSTAGRAM: two tenants do not leak (each merges into its own row)', async () => {
  const rows = { u1: { storeName: 'A1', x: 1 }, u2: { storeName: 'A2', y: 2 } };
  function db(uid) {
    return {
      query: async (sql, params) => {
        if (/SELECT[\s\S]*config[\s\S]*instagram_ai_settings/i.test(sql)) return { rows: [{ config: rows[uid] }] };
        if (/INSERT INTO instagram_ai_settings/i.test(sql)) { rows[uid] = JSON.parse(params[2]); return { rows: [] }; }
        return { rows: [] };
      },
    };
  }
  await saveInstagramConfig('u1', { enabled: true, config: { x: 99 } }, { database: db('u1') });
  assert.equal(rows.u1.x, 99);
  assert.equal(rows.u1.storeName, 'A1');
  assert.equal(rows.u2.storeName, 'A2'); // untouched
  assert.equal(rows.u2.y, 2);
});
