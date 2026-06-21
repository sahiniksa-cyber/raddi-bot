'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConversationOwnerPaused } = require('../src/workers/outgoing-whatsapp-worker');

function db(handler) {
  return { isConfigured: () => true, query: async (sql, params) => handler(sql, params) };
}

test('cancels when escalated_until is active (existing behavior preserved)', async () => {
  const future = new Date(Date.now() + 60000).toISOString();
  const d = db((sql) => (/escalated_until FROM conversations/.test(sql)
    ? { rows: [{ escalated_until: future }] }
    : { rows: [] }));
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', replyMessageId: 'r1', database: d }), true);
});

test('cancels when a HUMAN reply landed AFTER the AI reply, even with NO escalated_until', async () => {
  const d = db((sql) => {
    if (/escalated_until FROM conversations/.test(sql)) return { rows: [{ escalated_until: null }] };
    if (/JOIN messages hum/.test(sql)) return { rows: [{ x: 1 }] };
    return { rows: [] };
  });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', replyMessageId: 'r1', database: d }), true);
});

test('does NOT cancel when no human reply is newer than the AI reply', async () => {
  const d = db((sql) => {
    if (/escalated_until FROM conversations/.test(sql)) return { rows: [{ escalated_until: null }] };
    if (/JOIN messages hum/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', replyMessageId: 'r1', database: d }), false);
});

test('the human-reply query targets human-origin rows only (not the bot own AI sends)', async () => {
  let humSql = '';
  const d = db((sql) => {
    if (/JOIN messages hum/.test(sql)) { humSql = sql; return { rows: [] }; }
    return { rows: [{ escalated_until: null }] };
  });
  await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', replyMessageId: 'r1', database: d });
  assert.match(humSql, /sent_by_human/);
  assert.match(humSql, /source' = 'manual_send'/);
  // `>=` (not strict `>`) so a FAST same-tick owner reply is still caught.
  assert.match(humSql, /hum\.created_at >= ai\.created_at/);
});

test('no replyMessageId → only the time-window query runs (back-compat)', async () => {
  let calls = 0;
  const d = db(() => { calls++; return { rows: [{ escalated_until: null }] }; });
  const r = await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', database: d });
  assert.equal(r, false);
  assert.equal(calls, 1);
});
