'use strict';

// The keystore is a single JSONB column rewritten on every set(). Without
// debouncing, every inbound message triggers 2-4 multi-MB DB writes (one per
// ratchet step). The debounce coalesces N rapid set() calls in the same window
// into ONE write. flush() must drain the pending timer so a redeploy or
// reconnect never loses the latest ratchet step.

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysPostgresAuthState } = require('../src/services/whatsapp/baileys-postgres-auth');

function makeDb({ onWrite } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/SELECT auth_state/.test(sql)) return { rows: [{ auth_state: {} }] };
      writes.push({ sql, params });
      if (onWrite) await onWrite();
      return { rows: [] };
    },
  };
}

test('rapid set() calls coalesce into a single DB write within the debounce window', async () => {
  // Speed up the window so the test finishes fast.
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '50';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u1' });
  const { state } = await store.state();

  // 5 rapid writes, well under one debounce window.
  await state.keys.set({ session: { c1: { v: 1 } } });
  await state.keys.set({ session: { c1: { v: 2 } } });
  await state.keys.set({ session: { c2: { v: 1 } } });
  await state.keys.set({ session: { c3: { v: 1 } } });
  await state.keys.set({ session: { c4: { v: 1 } } });

  // No persist yet — debounce timer is still pending.
  assert.equal(db.writes.length, 0, 'no DB write before the debounce window elapses');

  // Wait past the window so the timer fires.
  await new Promise(r => setTimeout(r, 120));
  assert.equal(db.writes.length, 1, 'all 5 rapid writes must coalesce into one DB write');
});

test('saveCreds() persists immediately, bypassing the debounce', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '5000';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u2' });
  const { state, saveCreds } = await store.state();

  // Schedule a key write — sits in the debounce.
  await state.keys.set({ session: { c1: { v: 1 } } });
  assert.equal(db.writes.length, 0);

  await saveCreds();
  // saveCreds cancels the debounce and writes once, so we expect exactly one write.
  assert.equal(db.writes.length, 1, 'saveCreds must produce exactly one immediate write');
});

test('flush() drains the pending debounce timer', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '5000'; // long enough that the timer never fires naturally
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u3' });
  const { state, flush } = await store.state();

  await state.keys.set({ session: { c1: { v: 1 } } });
  assert.equal(db.writes.length, 0, 'no write while debounced');

  await flush();
  assert.equal(db.writes.length, 1, 'flush must persist the pending data immediately');
});

test('flush() with no pending work still resolves cleanly', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '50';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u4' });
  const { flush } = await store.state();

  await flush(); // nothing to do — must not hang or throw
  assert.equal(db.writes.length, 0);
});

test('flush() waits for ALL in-flight set() calls, not just the most recent', async () => {
  // Critical for the "Bad MAC" fix: if flush only awaited the LATEST set(),
  // an earlier slow set() could still be mid-flight and lose its keystore
  // mutation when the timer is cleared. The chain in _setChain solves this.
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '5000';
  let releaseLoad;
  const loadGate = new Promise(r => { releaseLoad = r; });
  let loadCount = 0;
  const db = {
    query: async (sql) => {
      if (/SELECT auth_state/.test(sql)) {
        loadCount++;
        if (loadCount === 1) await loadGate; // first load blocks
        return { rows: [{ auth_state: {} }] };
      }
      return { rows: [] };
    },
  };
  // Replace makeDb's write counter manually.
  const writes = [];
  const tracking = {
    query: async (sql, params) => {
      const res = await db.query(sql);
      if (!/SELECT auth_state/.test(sql)) writes.push({ sql, params });
      return res;
    },
  };
  const store = new BaileysPostgresAuthState({ db: tracking, userId: 'u-chain' });
  const { state, flush } = await new Promise((resolve) => {
    // state() awaits load(), which awaits loadGate — so resolve manually.
    store.state().then(resolve);
    setTimeout(() => releaseLoad(), 30); // let load() complete after state() awaits it
  });

  // Two concurrent sets — both must be drained by flush.
  state.keys.set({ session: { a: { v: 1 } } });
  state.keys.set({ session: { b: { v: 1 } } });

  await flush();
  assert.equal(writes.length, 1, 'flush must persist exactly once, covering both sets');
});

test('in-memory cache reflects the latest set() before the debounced write fires', async () => {
  process.env.WA_KEYSTORE_DEBOUNCE_MS = '5000';
  const db = makeDb();
  const store = new BaileysPostgresAuthState({ db, userId: 'u5' });
  const { state } = await store.state();

  await state.keys.set({ session: { c1: { v: 1 } } });
  await state.keys.set({ session: { c1: { v: 2 } } });
  // Cache is updated synchronously; durability is bounded by the debounce, but
  // a subsequent get() in the same tick sees the latest write.
  const value = await state.keys.get('session', ['c1']);
  assert.equal(value.c1.v, 2);
});
