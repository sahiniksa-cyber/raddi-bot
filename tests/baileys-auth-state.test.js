'use strict';

// Safeguards for the 2026-05-31 WhatsApp connection stability fixes:
// C1 — concurrent first-callers share a single load promise; no double-load
// C2 — clear() restores the previous cache if persist() fails (no silent wipe)

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysPostgresAuthState } = require('../src/services/whatsapp/baileys-postgres-auth');

function fakeDb({ rows = [], onUpdate = null, queryDelayMs = 0 } = {}) {
  let queryCalls = 0;
  let updateCalls = 0;
  return {
    queryCalls: () => queryCalls,
    updateCalls: () => updateCalls,
    async query(sql, params) {
      if (/^\s*SELECT/i.test(sql)) {
        queryCalls++;
        if (queryDelayMs > 0) await new Promise(r => setTimeout(r, queryDelayMs));
        return { rows };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        updateCalls++;
        if (onUpdate) return onUpdate(sql, params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

// ---------- C1 ----------

test('C1: concurrent load() calls share a single DB SELECT', async () => {
  const db = fakeDb({ rows: [], queryDelayMs: 20 });
  const store = new BaileysPostgresAuthState({ db, userId: 'u1' });

  await Promise.all([store.load(), store.load(), store.load(), store.load()]);
  assert.equal(db.queryCalls(), 1, 'all concurrent first-loaders must share the same in-flight load');
  assert.equal(store.loaded, true);
});

test('C1: load() is a no-op once cache is loaded', async () => {
  const db = fakeDb({ rows: [] });
  const store = new BaileysPostgresAuthState({ db, userId: 'u2' });
  await store.load();
  await store.load();
  await store.load();
  assert.equal(db.queryCalls(), 1, 'subsequent loads must not re-query');
});

test('C1: load() no longer auto-persists on first read (no wasted write race)', async () => {
  const db = fakeDb({ rows: [] });
  const store = new BaileysPostgresAuthState({ db, userId: 'u3' });
  await store.load();
  assert.equal(db.updateCalls(), 0, 'first load must not write back to DB');
});

// ---------- C2 ----------

test('C2: clear() restores cache + loaded if persist fails', async () => {
  // Pre-seed with non-empty creds, then fail the persist
  const seedCreds = { signedIdentityKey: { public: 'aaaa', private: 'bbbb' } };
  const seedKeys = { 'pre-key': { '1': { public: 'cccc' } } };

  const db = {
    async query(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: [{ auth_state: { baileys: { creds: seedCreds, keys: seedKeys } } }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error('simulated DB outage during clear');
      }
      return { rows: [] };
    },
  };

  const store = new BaileysPostgresAuthState({ db, userId: 'u4' });
  await store.load();
  const prevCreds = store.cache.creds;
  const prevKeys = store.cache.keys;
  assert.ok(prevCreds, 'pre-seeded creds expected');

  await assert.rejects(store.clear(), /simulated DB outage/);

  assert.equal(store.cache.creds, prevCreds, 'creds must be restored after failed persist');
  assert.equal(store.cache.keys, prevKeys, 'keys must be restored after failed persist');
  assert.equal(store.loaded, true);
});

test('C2: clear() leaves an empty cache only when persist succeeds', async () => {
  let updateCalls = 0;
  const db = {
    async query(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: [{ auth_state: { baileys: { creds: { x: 1 }, keys: { 'pre-key': { 1: { p: 'aa' } } } } } }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        updateCalls++;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const store = new BaileysPostgresAuthState({ db, userId: 'u5' });
  await store.load();
  await store.clear();

  // After successful clear, keys should be empty and creds should be a fresh initAuthCreds object
  assert.deepEqual(store.cache.keys, {});
  assert.ok(store.cache.creds, 'fresh creds object created');
  assert.equal(updateCalls >= 1, true, 'persist must have been called');
});
