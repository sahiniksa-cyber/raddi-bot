'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConversationOwnerPaused } = require('../src/workers/outgoing-whatsapp-worker');

function fakeDb({ rows = [], throwErr = null, configured = true } = {}) {
  return {
    isConfigured: () => configured,
    query: async () => {
      if (throwErr) throw throwErr;
      return { rows };
    },
  };
}

test('paused: escalated_until in the future blocks the send', async () => {
  const database = fakeDb({ rows: [{ escalated_until: new Date(Date.now() + 60_000) }] });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', database }), true);
});

test('not paused: escalated_until in the past allows the send', async () => {
  const database = fakeDb({ rows: [{ escalated_until: new Date(Date.now() - 60_000) }] });
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's@c.us', database }), false);
});

test('fail-open: no row, null column, db error, db not configured', async () => {
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ rows: [] }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ rows: [{ escalated_until: null }] }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ throwErr: new Error('column does not exist') }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: 'u1', sender: 's', database: fakeDb({ configured: false }) }), false);
  assert.equal(await isConversationOwnerPaused({ userId: null, sender: 's', database: fakeDb({ rows: [] }) }), false);
});
