'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listPausedChats, resumePausedChat } = require('../src/services/bot/paused-chats');

function fakeDb(handler) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params) || { rows: [], rowCount: 0 };
    },
  };
}

test('listPausedChats returns sender + remainingMin for active mutes', async () => {
  const db = fakeDb((sql) => {
    if (/FROM conversations/.test(sql)) {
      return { rows: [
        { sender: '966511111111@c.us', remaining_min: 12 },
        { sender: '966522222222@c.us', remaining_min: 30 },
      ] };
    }
  });
  const out = await listPausedChats(db, 'user-1');
  assert.deepEqual(out, [
    { sender: '966511111111@c.us', remainingMin: 12 },
    { sender: '966522222222@c.us', remainingMin: 30 },
  ]);
  const q = db.calls[0];
  assert.match(q.sql, /escalated_until\s*>\s*NOW\(\)/);
  assert.match(q.sql, /user_id\s*=\s*\$1/);
  assert.equal(q.params[0], 'user-1');
});

test('listPausedChats returns empty array when none active', async () => {
  const db = fakeDb(() => ({ rows: [] }));
  const out = await listPausedChats(db, 'user-1');
  assert.deepEqual(out, []);
});

test('resumePausedChat for a specific sender filters by user + sender and clears escalated_until', async () => {
  const db = fakeDb((sql) => {
    if (/UPDATE conversations/.test(sql)) return { rowCount: 1 };
  });
  const n = await resumePausedChat(db, 'user-1', '966511111111@c.us');
  assert.equal(n, 1);
  const q = db.calls[0];
  assert.match(q.sql, /SET escalated_until = NULL/);
  assert.match(q.sql, /sender\s*=\s*\$2/);
  assert.equal(q.params[0], 'user-1');
  assert.equal(q.params[1], '966511111111@c.us');
});

test('resumePausedChat with null sender clears all paused chats for the user', async () => {
  const db = fakeDb((sql) => {
    if (/UPDATE conversations/.test(sql)) return { rowCount: 3 };
  });
  const n = await resumePausedChat(db, 'user-1', null);
  assert.equal(n, 3);
  const q = db.calls[0];
  assert.match(q.sql, /SET escalated_until = NULL/);
  assert.doesNotMatch(q.sql, /sender\s*=\s*\$2/);
  assert.equal(q.params.length, 1);
  assert.equal(q.params[0], 'user-1');
});
