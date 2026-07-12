'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getInstagramMerchantView,
  adminDisconnectInstagram,
  adminSetInstagramAi,
} = require('../src/services/admin/instagram-admin');

// Fake db: returns queued results in call order; an Error in the queue is thrown.
function fakeDb(queue = []) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const r = queue[calls.length - 1];
      if (r instanceof Error) throw r;
      return r || { rows: [], rowCount: 0 };
    },
  };
}

// ---------- getInstagramMerchantView ----------

test('getInstagramMerchantView aggregates connection + settings + stats', async () => {
  const connectedAt = new Date('2026-07-01T00:00:00Z');
  const tokenExp = new Date('2026-09-10T00:00:00Z'); // ~60 days after `now`
  const db = fakeDb([
    { rows: [{ enabled: true, config: { model: 'claude-sonnet-5' } }] }, // settings
    { rows: [{ n: 4 }] },   // activeConversations
    { rows: [{ n: 12 }] },  // repliesCount
    { rows: [{ created_at: new Date('2026-07-12T09:00:00Z') }] }, // last inbound
    { rows: [{ created_at: new Date('2026-07-12T09:01:00Z') }] }, // last outbound
  ]);
  const accounts = {
    getAccount: async () => ({
      status: 'connected', ig_username: 'designer_shahini', ig_user_id: '153',
      connected_at: connectedAt, token_expires_at: tokenExp,
    }),
  };
  const out = await getInstagramMerchantView('u1', {
    db, accounts, now: new Date('2026-07-12T00:00:00Z').getTime(),
  });
  assert.equal(out.connected, true);
  assert.equal(out.username, 'designer_shahini');
  assert.equal(out.igUserId, '153');
  assert.equal(out.aiEnabled, true);
  assert.equal(out.model, 'claude-sonnet-5');
  assert.equal(out.activeConversations, 4);
  assert.equal(out.repliesCount, 12);
  assert.ok(out.lastInboundAt);
  assert.ok(out.lastOutboundAt);
  assert.equal(out.tokenExpired, false);
  assert.equal(out.tokenExpiresInDays, 60);
});

test('getInstagramMerchantView reports not-connected when no account exists', async () => {
  const db = fakeDb([{ rows: [] }]); // settings empty; account stub returns null
  const accounts = { getAccount: async () => null };
  const out = await getInstagramMerchantView('u1', { db, accounts });
  assert.equal(out.connected, false);
  assert.equal(out.status, 'not_connected');
  assert.equal(out.username, null);
  assert.equal(out.aiEnabled, false);
  assert.equal(out.model, 'gpt-4o'); // default
});

test('getInstagramMerchantView is READ-ONLY (never INSERTs/seeds a settings row)', async () => {
  const db = fakeDb([{ rows: [] }]);
  const accounts = { getAccount: async () => null };
  await getInstagramMerchantView('u1', { db, accounts });
  for (const c of db.calls) {
    assert.doesNotMatch(c.text, /INSERT|UPDATE/i, 'admin view must not mutate IG tables');
  }
});

test('getInstagramMerchantView flags an expired token', async () => {
  const db = fakeDb([{ rows: [{ enabled: false, config: {} }] }]);
  const accounts = {
    getAccount: async () => ({
      status: 'connected', ig_username: 'x', ig_user_id: '1',
      token_expires_at: new Date('2026-06-01T00:00:00Z'),
    }),
  };
  const out = await getInstagramMerchantView('u1', {
    db, accounts, now: new Date('2026-07-12T00:00:00Z').getTime(),
  });
  assert.equal(out.tokenExpired, true);
  assert.ok(out.tokenExpiresInDays < 0);
});

test('getInstagramMerchantView survives a stats query error (degrades to zeros)', async () => {
  const db = fakeDb([
    { rows: [{ enabled: true, config: {} }] },
    new Error('table missing'),
  ]);
  const accounts = { getAccount: async () => ({ status: 'connected', ig_username: 'x' }) };
  const out = await getInstagramMerchantView('u1', { db, accounts });
  assert.equal(out.connected, true);
  assert.equal(out.activeConversations, 0);
  assert.equal(out.repliesCount, 0);
});

test('getInstagramMerchantView requires userId', async () => {
  await assert.rejects(() => getInstagramMerchantView('  ', { db: fakeDb() }), /userId required/);
});

// ---------- adminDisconnectInstagram ----------

test('adminDisconnectInstagram delegates to accounts.disconnectAccount', async () => {
  let called = null;
  const accounts = { disconnectAccount: async (uid, opts) => { called = { uid, opts }; } };
  const db = fakeDb();
  const res = await adminDisconnectInstagram('u1', { db, accounts });
  assert.deepEqual(res, { disconnected: true });
  assert.equal(called.uid, 'u1');
  assert.equal(called.opts.database, db);
});

test('adminDisconnectInstagram requires userId', async () => {
  await assert.rejects(() => adminDisconnectInstagram('', {}), /userId required/);
});

// ---------- adminSetInstagramAi ----------

test('adminSetInstagramAi flips the flag via config.setAiEnabled', async () => {
  const seen = [];
  const config = { setAiEnabled: async (uid, enabled) => { seen.push({ uid, enabled }); } };
  const db = fakeDb();
  const on = await adminSetInstagramAi('u1', true, { db, config });
  assert.deepEqual(on, { aiEnabled: true });
  const off = await adminSetInstagramAi('u1', false, { db, config });
  assert.deepEqual(off, { aiEnabled: false });
  assert.deepEqual(seen, [{ uid: 'u1', enabled: true }, { uid: 'u1', enabled: false }]);
});

test('adminSetInstagramAi coerces non-true to false', async () => {
  let passed = null;
  const config = { setAiEnabled: async (uid, enabled) => { passed = enabled; } };
  const res = await adminSetInstagramAi('u1', 'yes', { db: fakeDb(), config });
  assert.equal(res.aiEnabled, false);
  assert.equal(passed, false);
});
