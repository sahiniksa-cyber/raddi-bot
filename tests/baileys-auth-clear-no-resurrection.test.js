'use strict';

// Regression for the "bad QR after disconnect" bug. On logout the manager
// clears the auth so a fresh QR appears, but the LIVE store could resurrect
// stale keys over the wipe via (a) a pending debounced persist or (b) a late
// set()/saveCreds from the dying socket. The fix disposes the live store
// BEFORE clearing so nothing can clobber the wipe.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BaileysPostgresAuthState,
  usePostgresBaileysAuthState,
} = require('../src/services/whatsapp/baileys-postgres-auth');

// Mirrors the harness in baileys-keystore-debounce.test.js: SELECT returns the
// seed rows; every UPDATE is recorded so we can assert what actually persisted.
function makeDb({ rows = [{ auth_state: {} }] } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/SELECT auth_state/.test(sql)) return { rows };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
}

// Parse the baileys payload out of a recorded UPDATE (param[1] is the JSON).
function payloadOf(write) {
  return JSON.parse(write.params[1]);
}

// ---------- (a) disposed store performs no further writes ----------

test('(a) after dispose(), keys.set() schedules no DB write and saveCreds() does not write', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '50';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u-dispose' });
  const { state, saveCreds } = await store.state();

  store.dispose();

  await state.keys.set({ session: { c1: { v: 1 } } });
  await saveCreds();

  // Wait well past the debounce window — nothing should have fired.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(db.writes.length, 0, 'disposed store must not write via set() debounce or saveCreds()');
  assert.equal(store._persistDebounce, null, 'no debounce timer left pending after dispose');
});

// ---------- (b) clear() after dispose() still wipes ----------

test('(b) clear() AFTER dispose() still wipes the DB (empty keys + fresh creds)', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '5000';
  const db = makeDb({
    rows: [{ auth_state: { baileys: { creds: { old: 1 }, keys: { 'pre-key': { 1: { p: 'aa' } } } } } }],
  });
  const store = new BaileysPostgresAuthState({ db, userId: 'u-clear' });
  await store.load();

  store.dispose();
  await store.clear();

  assert.deepEqual(store.cache.keys, {}, 'cache keys wiped');
  assert.ok(store.cache.creds, 'fresh creds object present');
  assert.ok(db.writes.length >= 1, 'clear() must persist the wipe even after dispose');

  const last = payloadOf(db.writes[db.writes.length - 1]);
  assert.deepEqual(last.keys, {}, 'persisted keys must be empty after clear');
});

// ---------- (c) THE KEY SCENARIO: no resurrection ----------

test('(c) pending keystore write + dispose + clear → final persisted state has EMPTY keys (no resurrection)', async () => {
  // Short window so the dying socket's late set() can actually fire its
  // debounced persist AFTER the clear — exactly the race that resurrected
  // stale keys before the fix.
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '30';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u-race' });
  const { state } = await store.state();

  // Logout path: dispose the live store, then clear it (wipes DB + cache).
  store.dispose();
  await store.clear();
  const writesAfterClear = db.writes.length;
  assert.ok(writesAfterClear >= 1, 'the clear wipe was persisted');

  // The DYING socket emits one more keystore write AFTER the clear (in-flight
  // signal step landing late). Pre-fix this re-populated the cache AND
  // scheduled a persist that lands on top of the wipe → stale keys resurrected.
  await state.keys.set({ session: { stale1: { v: 1 } }, 'pre-key': { 9: { p: 'zz' } } });

  // Give the debounce window time to fire (30ms) — well past it.
  await new Promise((r) => setTimeout(r, 120));

  // With the fix: no new write was scheduled by the disposed store, so the
  // last persisted state is still the empty wipe.
  assert.equal(db.writes.length, writesAfterClear,
    'disposed store must not persist the late set() (no stale write after clear)');
  const last = payloadOf(db.writes[db.writes.length - 1]);
  assert.deepEqual(last.keys, {}, 'final persisted keys must be EMPTY (stale keys not resurrected)');
});

// ---------- (d) usePostgresBaileysAuthState shape ----------

test('(d) usePostgresBaileysAuthState returns state, saveCreds, flush AND store', async () => {
  const db = makeDb();
  const result = await usePostgresBaileysAuthState({ db, userId: 'u-shape' });
  assert.ok(result.state, 'state present');
  assert.equal(typeof result.saveCreds, 'function', 'saveCreds present');
  assert.equal(typeof result.flush, 'function', 'flush present');
  assert.ok(result.store instanceof BaileysPostgresAuthState, 'store instance exposed');
  assert.equal(typeof result.store.dispose, 'function', 'store has dispose()');
});
