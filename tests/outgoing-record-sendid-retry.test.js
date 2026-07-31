'use strict';

// Behavioral tests for Phase 5: the dedup-anchor write (whatsapp_message_id)
// must survive a transient DB failure instead of being silently swallowed, so a
// reconnect/crash requeue can detect an already-delivered reply and not resend.

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordWhatsappMessageId, isReplyAlreadySent } = require('../src/workers/outgoing-whatsapp-worker');

function fakeDb({ failTimes = 0 } = {}) {
  let fails = 0;
  const state = { updates: 0 };
  return {
    state,
    isConfigured: () => true,
    async query(sql, params) {
      if (/UPDATE messages/.test(sql)) {
        if (fails < failTimes) { fails += 1; throw new Error(`transient db error #${fails}`); }
        state.updates += 1;
        state.lastParams = params;
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const args = (database) => ({
  userId: 'u1', conversationId: 'c1', sender: '9665@s.whatsapp.net',
  replyMessageId: 'r1', whatsappMessageId: 'WAMID123', database, attempts: 3,
});

test('records the dedup anchor on the first successful attempt', async () => {
  const db = fakeDb({ failTimes: 0 });
  const ok = await recordWhatsappMessageId(args(db));
  assert.equal(ok, true);
  assert.equal(db.state.updates, 1);
  assert.equal(db.state.lastParams[4], 'WAMID123');
});

test('retries a transient failure, then persists the anchor (no silent loss)', async () => {
  const db = fakeDb({ failTimes: 2 }); // fail twice, succeed on the 3rd
  const ok = await recordWhatsappMessageId(args(db));
  assert.equal(ok, true);
  assert.equal(db.state.updates, 1);
});

test('gives up after N attempts WITHOUT throwing, and reports failure', async () => {
  const db = fakeDb({ failTimes: 99 });
  const ok = await recordWhatsappMessageId(args(db)); // must not throw
  assert.equal(ok, false);
  assert.equal(db.state.updates, 0);
});

test('missing required fields → no write, returns false', async () => {
  const db = fakeDb();
  const ok = await recordWhatsappMessageId({ userId: 'u1', database: db });
  assert.equal(ok, false);
  assert.equal(db.state.updates, 0);
});

test('isReplyAlreadySent treats a persisted whatsapp_message_id as delivered (dedup)', async () => {
  const database = {
    isConfigured: () => true,
    async query() { return { rows: [{ status: 'queued_for_send', whatsapp_message_id: 'WAMID123' }] }; },
  };
  const sent = await isReplyAlreadySent({ replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database });
  assert.equal(sent, true, 'anchor present → already sent → requeue must skip');
});
