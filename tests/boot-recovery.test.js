'use strict';

// Guards boot-time WhatsApp recovery: after a restart, EVERY session with
// desired_state='running' must be auto-resolved (reconnected) without anyone
// opening its dashboard — staggered to avoid a reconnect thundering herd.

const test = require('node:test');
const assert = require('node:assert/strict');

const { recoverRunningBots } = require('../src/runtime/boot-recovery');

function fakeDb(rows) {
  return { isConfigured: () => true, query: async () => ({ rows }) };
}
// Synchronous schedule stub: run the callback immediately, record the delay.
function immediateSchedule(delays) {
  return (fn, delay) => { delays.push(delay); fn(); return { unref() {} }; };
}

test('resolves every running bot exactly once', async () => {
  const resolved = [];
  const res = await recoverRunningBots({
    db: fakeDb([{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }]),
    resolveBot: async (id) => { resolved.push(id); },
    schedule: immediateSchedule([]),
  });
  assert.equal(res.scheduled, 3);
  assert.deepEqual(resolved.sort(), ['a', 'b', 'c']);
});

test('staggers resolutions by an increasing delay', async () => {
  const delays = [];
  await recoverRunningBots({
    db: fakeDb([{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }]),
    resolveBot: async () => {},
    staggerMs: 1000,
    schedule: immediateSchedule(delays),
  });
  assert.deepEqual(delays, [0, 1000, 2000], 'each bot is offset further out');
});

test('does nothing when the DB is not configured', async () => {
  let called = 0;
  const res = await recoverRunningBots({
    db: { isConfigured: () => false, query: async () => { called++; return { rows: [] }; } },
    resolveBot: async () => { called++; },
    schedule: immediateSchedule([]),
  });
  assert.equal(res.scheduled, 0);
  assert.equal(called, 0);
});

test('a single bot failing does not stop the others', async () => {
  const resolved = [];
  await recoverRunningBots({
    db: fakeDb([{ user_id: 'a' }, { user_id: 'bad' }, { user_id: 'c' }]),
    resolveBot: async (id) => { if (id === 'bad') throw new Error('boom'); resolved.push(id); },
    schedule: immediateSchedule([]),
    log: () => {},
  });
  assert.deepEqual(resolved.sort(), ['a', 'c'], 'good bots still recover');
});

test('survives a query error without throwing', async () => {
  const res = await recoverRunningBots({
    db: { isConfigured: () => true, query: async () => { throw new Error('db down'); } },
    resolveBot: async () => {},
    schedule: immediateSchedule([]),
    log: () => {},
  });
  assert.equal(res.scheduled, 0);
});

test('requires a resolveBot function', async () => {
  await assert.rejects(() => recoverRunningBots({ db: fakeDb([]) }), /resolveBot is required/);
});
