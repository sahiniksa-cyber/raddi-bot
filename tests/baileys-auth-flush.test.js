'use strict';

// On shutdown we must flush queued signal-key writes, otherwise a redeploy can
// kill the process mid-write and lose the latest Double-Ratchet step — which
// surfaces as "Bad MAC" on the next inbound message until the session
// re-negotiates. The auth store exposes flush(); the connection manager awaits
// it in stop().

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysPostgresAuthState } = require('../src/services/whatsapp/baileys-postgres-auth');

function makeDb({ onWrite } = {}) {
  return {
    query: async (sql) => {
      if (/SELECT auth_state/.test(sql)) return { rows: [{ auth_state: {} }] };
      if (onWrite) await onWrite(); // simulate write latency
      return { rows: [] };
    },
  };
}

test('flush() waits for queued key writes to finish', async () => {
  let writeDone = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = new BaileysPostgresAuthState({
    db: makeDb({ onWrite: async () => { await gate; writeDone = true; } }),
    userId: 'u1',
  });
  const { state, flush } = await store.state();

  // Queue a key write (does not await the DB write).
  state.keys.set({ session: { 'contact-1': { v: 1 } } });

  assert.equal(writeDone, false, 'write is still queued, not yet flushed');
  release(); // let the DB write proceed
  await flush();
  assert.equal(writeDone, true, 'flush resolves only after the queued write completes');
});

test('flush() never throws even if a write fails', async () => {
  const store = new BaileysPostgresAuthState({
    db: {
      query: async (sql) => {
        if (/SELECT auth_state/.test(sql)) return { rows: [{ auth_state: {} }] };
        throw new Error('db write failed');
      },
    },
    userId: 'u2',
  });
  const { state, flush } = await store.state();
  state.keys.set({ session: { 'c': { v: 1 } } }).catch(() => {});
  await flush(); // must not reject
  assert.ok(true, 'flush swallowed the write error');
});
