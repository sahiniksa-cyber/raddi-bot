'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { searchMerchants } = require('../src/services/admin/merchant-search');
const { logAdminAction, listAdminAuditLog } = require('../src/services/admin/admin-audit');
const { getMerchantDiagnostics, forceReleaseLease } = require('../src/services/admin/merchant-diagnostics');

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

// ---------- searchMerchants ----------

test('searchMerchants returns [] for empty query without touching db', async () => {
  const db = fakeDb();
  const out = await searchMerchants('   ', { db });
  assert.deepEqual(out, []);
  assert.equal(db.calls.length, 0);
});

test('searchMerchants builds text + phone params and maps rows', async () => {
  const db = fakeDb([
    { rows: [{ id: 'u1', name: 'متجر', email: 'a@b.com', phone: '', whatsapp_status: 'connected', messages_remaining: 50, platform_access_status: 'paid' }] },
  ]);
  const out = await searchMerchants('966500123456', { db, limit: 10 });
  const call = db.calls[0];
  assert.equal(call.params[0], '%966500123456%');   // textLike
  assert.equal(call.params[1], '966500123456');      // digits
  assert.equal(call.params[2], '%966500123456%');    // phoneLike
  assert.equal(call.params[3], 10);                  // limit
  assert.equal(out.length, 1);
  assert.equal(out[0].userId, 'u1');
  assert.equal(out[0].messagesRemaining, 50);
  assert.equal(out[0].whatsappStatus, 'connected');
});

test('searchMerchants clamps limit to 50', async () => {
  const db = fakeDb([{ rows: [] }]);
  await searchMerchants('x', { db, limit: 9999 });
  assert.equal(db.calls[0].params[3], 50);
});

// ---------- logAdminAction ----------

test('logAdminAction inserts with correct params and returns logged:true', async () => {
  const db = fakeDb([{ rows: [], rowCount: 1 }]);
  const res = await logAdminAction(
    { adminUserId: 'admin1', action: 'bot_restart', targetUserId: 'u1', detail: { foo: 'bar' } },
    { db },
  );
  assert.equal(res.logged, true);
  const call = db.calls[0];
  assert.match(call.text, /INSERT INTO admin_audit_log/);
  assert.equal(call.params[0], 'admin1');
  assert.equal(call.params[1], 'bot_restart');
  assert.equal(call.params[2], 'u1');
  assert.equal(call.params[3], JSON.stringify({ foo: 'bar' }));
  assert.equal(call.params[4], 'ok');
});

test('logAdminAction NEVER throws on db error (returns logged:false)', async () => {
  const db = fakeDb([new Error('db down')]);
  const res = await logAdminAction({ action: 'bot_stop', targetUserId: 'u1' }, { db });
  assert.equal(res.logged, false);
  assert.match(res.error, /db down/);
});

test('logAdminAction requires an action', async () => {
  const db = fakeDb();
  await assert.rejects(() => logAdminAction({ action: '' }, { db }), /action required/);
});

test('listAdminAuditLog uses target filter when given and clamps limit', async () => {
  const db = fakeDb([{ rows: [{ id: 'a1' }] }]);
  const rows = await listAdminAuditLog({ targetUserId: 'u1', limit: 5000 }, { db });
  assert.equal(rows.length, 1);
  assert.match(db.calls[0].text, /WHERE target_user_id = \$1/);
  assert.equal(db.calls[0].params[0], 'u1');
  assert.equal(db.calls[0].params[1], 200); // clamped
});

// ---------- getMerchantDiagnostics ----------

test('getMerchantDiagnostics returns null for unknown user', async () => {
  const db = fakeDb([{ rows: [] }]);
  const out = await getMerchantDiagnostics('nope', { db });
  assert.equal(out, null);
  assert.equal(db.calls.length, 1); // short-circuits after the info query
});

test('getMerchantDiagnostics aggregates identity, billing, whatsapp, counts, live', async () => {
  const when = new Date('2026-06-13T10:00:00Z');
  const db = fakeDb([
    { rows: [{
      id: 'u1', name: 'متجر', email: 'a@b.com', phone: '', role: 'user', created_at: when,
      messages_remaining: 100, quota_expires_at: null, expire_resets_quota: true,
      platform_access_status: 'paid', last_topup_at: null, last_topup_amount: 0,
      ws_status: 'connected', ws_phone: '966500', last_connected_at: when,
      last_disconnected_at: null, last_error: null, reconnect_count: 2, desired_state: 'running',
      connection_owner: 'inst1', connection_lease_expires_at: when,
    }] },
    { rows: [{ status: 'queued_for_ai', n: 3 }, { status: 'sent', n: 10 }] },
    { rows: [{ created_at: when }] },
  ]);
  const getUserBot = async () => ({
    appState: { status: 'connected', statusAgeMs: 1200, error: null, reconnectCount: 2, desiredState: 'running', logs: ['a', 'b'] },
    isInConnConflictBackoff: () => false,
  });
  const out = await getMerchantDiagnostics('u1', { db, getUserBot });
  assert.equal(out.identity.userId, 'u1');
  assert.equal(out.identity.phone, '966500');      // prefers linked WA phone
  assert.equal(out.billing.messagesRemaining, 100);
  assert.equal(out.whatsapp.reconnectCount, 2);
  assert.equal(out.whatsapp.leaseOwner, 'inst1');
  assert.deepEqual(out.messageCounts, { queued_for_ai: 3, sent: 10 });
  assert.equal(out.live.status, 'connected');
  assert.equal(out.live.inConnConflictBackoff, false);
  assert.ok(out.lastReplyAt);
});

test('getMerchantDiagnostics survives a failing getUserBot (live.error set)', async () => {
  const db = fakeDb([
    { rows: [{ id: 'u1', name: '', email: '', phone: '', role: 'user', created_at: new Date(), ws_status: 'stopped', ws_phone: '' }] },
    { rows: [] },
    { rows: [] },
  ]);
  const getUserBot = async () => { throw new Error('not loaded'); };
  const out = await getMerchantDiagnostics('u1', { db, getUserBot });
  assert.equal(out.live.error, 'not loaded');
});

// ---------- forceReleaseLease ----------

test('forceReleaseLease clears lease columns UNCONDITIONALLY (no owner check)', async () => {
  const db = fakeDb([{ rowCount: 1 }]);
  const res = await forceReleaseLease('u1', { db });
  assert.equal(res.released, true);
  const call = db.calls[0];
  assert.match(call.text, /connection_owner = NULL/);
  assert.match(call.text, /connection_lease_expires_at = NULL/);
  // The WHERE must be user-only — must NOT be scoped to connection_owner,
  // otherwise it could not clear a lease held by a dead instance.
  assert.match(call.text, /WHERE user_id = \$1/);
  assert.doesNotMatch(call.text, /connection_owner = \$2/);
  assert.equal(call.params[0], 'u1');
});

test('forceReleaseLease reports released:false when no row matched', async () => {
  const db = fakeDb([{ rowCount: 0 }]);
  const res = await forceReleaseLease('ghost', { db });
  assert.equal(res.released, false);
});
