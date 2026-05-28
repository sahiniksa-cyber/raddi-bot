'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractAsync } = require('../src/workers/profile-extractor');

test('extractAsync returns synchronously (undefined) and does NOT block the caller', () => {
  const fake = {
    isConfigured: () => true,
    query: async () => { /* slow-ish, but we never await it */ return { rows: [] }; },
  };
  const start = Date.now();
  const ret = extractAsync({
    conversationId: 'c1',
    userId: 'u1',
    customerText: 'اسمي خالد ايميلي k@x.com',
    database: fake,
  });
  const elapsed = Date.now() - start;
  assert.equal(ret, undefined, 'extractAsync must not return a Promise to the caller');
  assert.ok(elapsed < 20, `extractAsync must return immediately (got ${elapsed}ms)`);
});

test('extractAsync schedules its DB work on a later tick (setImmediate)', async () => {
  let queryRan = false;
  const fake = {
    isConfigured: () => true,
    query: async () => { queryRan = true; return { rows: [], rowCount: 1 }; },
  };
  extractAsync({
    conversationId: 'c1',
    userId: 'u1',
    customerText: 'اسمي خالد',
    database: fake,
  });
  // Synchronously after the call, the query must not have executed yet.
  assert.equal(queryRan, false, 'DB work must be deferred, not run synchronously');

  // Allow the setImmediate to drain.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queryRan, true, 'DB work should have run after setImmediate drained');
});

test('extractAsync swallows errors thrown by the underlying DB and does not crash the process', async () => {
  // We capture unhandledRejection / uncaughtException to be sure neither fires.
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(['unhandledRejection', e]);
  const onUncaught = (e) => unhandled.push(['uncaughtException', e]);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);

  try {
    const fake = {
      isConfigured: () => true,
      query: async () => { throw new Error('db boom'); },
    };
    extractAsync({
      conversationId: 'c1',
      userId: 'u1',
      customerText: 'اسمي خالد',
      database: fake,
    });
    // Drain ticks.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(unhandled.length, 0, `expected no unhandled errors, got: ${JSON.stringify(unhandled.map(([k, e]) => [k, e && e.message]))}`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    process.removeListener('uncaughtException', onUncaught);
  }
});

test('extractAsync with empty text does not call the DB at all', async () => {
  let queryCalls = 0;
  const fake = {
    isConfigured: () => true,
    query: async () => { queryCalls++; return { rows: [] }; },
  };
  extractAsync({
    conversationId: 'c1',
    userId: 'u1',
    customerText: '',
    database: fake,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queryCalls, 0, 'no extractable fields means no DB roundtrip');
});

test('extractAsync with no conversationId/userId is a safe no-op', async () => {
  let queryCalls = 0;
  const fake = {
    isConfigured: () => true,
    query: async () => { queryCalls++; return { rows: [] }; },
  };
  extractAsync({
    conversationId: null,
    userId: null,
    customerText: 'اسمي خالد ايميلي k@x.com',
    database: fake,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queryCalls, 0);
});
