'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SEND_STALE_GUARD_ENABLED = 'true';
const { claimSendOrStale } = require('../src/workers/outgoing-whatsapp-worker');

function db(rowCount) {
  return { isConfigured: () => true, async query() { return { rows: rowCount ? [{ id: 'r1' }] : [], rowCount }; } };
}

test('claimSendOrStale returns true when the atomic UPDATE claims 1 row', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42, database: db(1),
  });
  assert.equal(ok, true);
});

test('claimSendOrStale returns false (stale) when 0 rows claimed', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42, database: db(0),
  });
  assert.equal(ok, false);
});

test('claimSendOrStale is fail-open: missing generatedAgainstSeq → true (legacy send)', async () => {
  const ok = await claimSendOrStale({ replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: db(0) });
  assert.equal(ok, true);
});

test('claimSendOrStale treats seq 0 as a real value (not fail-open)', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 0, database: db(0),
  });
  assert.equal(ok, false); // seq 0 is valid; 0 rows means stale
});

test('claimSendOrStale is disabled when flag is off → true', async () => {
  const prev = process.env.SEND_STALE_GUARD_ENABLED;
  process.env.SEND_STALE_GUARD_ENABLED = 'false';
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42, database: db(0),
  });
  assert.equal(ok, true);
  process.env.SEND_STALE_GUARD_ENABLED = prev;
});

function dbThatThrows() {
  return { isConfigured: () => true, async query() { throw new Error('connection terminated'); } };
}

test('DB error WITHOUT throwOnError → legacy fail-open (true) — protects manual/campaign callers', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42, database: dbThatThrows(),
  });
  assert.equal(ok, true);
});

test('DB error WITH throwOnError → throws a RETRIABLE error (AI reply must NOT send unverified)', async () => {
  await assert.rejects(
    () => claimSendOrStale({
      replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42,
      database: dbThatThrows(), throwOnError: true,
    }),
    (err) => {
      assert.equal(err.code, 'STALE_GUARD_DB_ERROR');
      assert.equal(err.retriable, true);
      return true;
    },
  );
});

test('unconfigured DB WITH throwOnError → throws retriable (cannot verify → do not send)', async () => {
  await assert.rejects(
    () => claimSendOrStale({
      replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 42,
      database: { isConfigured: () => false }, throwOnError: true,
    }),
    (err) => err.code === 'STALE_GUARD_DB_ERROR' && err.retriable === true,
  );
});

test('seq absent WITH throwOnError → still fail-open (true): pre-migration job, not a failure', async () => {
  const ok = await claimSendOrStale({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: dbThatThrows(), throwOnError: true,
  });
  assert.equal(ok, true); // seq null short-circuits BEFORE any DB call
});
