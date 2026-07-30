'use strict';

// Behavioral tests for Phase 1 DB retention/cleanup. No real DB: a fake `db`
// records every query and returns programmed responses, so we assert the ACTUAL
// runtime behavior (batching, dry-run, advisory lock, safety filters), not
// source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRetentionConfig,
  isMessageDeletable,
  isJobDeletable,
  runRetentionSweep,
  ensureRetentionIndexes,
  messagesSpec,
  jobsSpec,
  MESSAGE_INFLIGHT_STATUSES,
} = require('../src/services/maintenance/db-retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock
const OLD = new Date(NOW - 200 * DAY).toISOString();
const RECENT = new Date(NOW - 1 * DAY).toISOString();

// ── Pure safety helpers: never delete in-flight or recent rows ───────────────
test('isMessageDeletable: NEVER deletes in-flight messages, even if very old', () => {
  const cutoff = NOW - 90 * DAY;
  for (const status of MESSAGE_INFLIGHT_STATUSES) {
    assert.equal(isMessageDeletable({ status, created_at: OLD }, cutoff), false, `${status} must be kept`);
  }
});

test('isMessageDeletable: deletes only TERMINAL messages older than the cutoff', () => {
  const cutoff = NOW - 90 * DAY;
  assert.equal(isMessageDeletable({ status: 'answered_by_ai', created_at: OLD }, cutoff), true);
  assert.equal(isMessageDeletable({ status: 'sent', created_at: OLD }, cutoff), true);
  assert.equal(isMessageDeletable({ status: 'ai_failed', created_at: OLD }, cutoff), true);
  // recent terminal → kept
  assert.equal(isMessageDeletable({ status: 'sent', created_at: RECENT }, cutoff), false);
  // unknown status → conservatively kept
  assert.equal(isMessageDeletable({ status: 'some_new_status', created_at: OLD }, cutoff), false);
  // malformed → kept
  assert.equal(isMessageDeletable({ status: 'sent', created_at: 'not-a-date' }, cutoff), false);
  assert.equal(isMessageDeletable(null, cutoff), false);
});

test('isJobDeletable: keeps non-terminal jobs; deletes old terminal jobs only', () => {
  const cutoff = NOW - 14 * DAY;
  for (const status of ['queued', 'active', 'pending', 'retrying']) {
    assert.equal(isJobDeletable({ status, finished_at: OLD }, cutoff), false, `${status} must be kept`);
  }
  assert.equal(isJobDeletable({ status: 'completed', finished_at: OLD }, cutoff), true);
  assert.equal(isJobDeletable({ status: 'failed', finished_at: OLD }, cutoff), true);
  assert.equal(isJobDeletable({ status: 'completed', finished_at: RECENT }, cutoff), false);
  // falls back to updated_at/created_at when finished_at missing
  assert.equal(isJobDeletable({ status: 'canceled', updated_at: OLD }, cutoff), true);
});

// ── Config ───────────────────────────────────────────────────────────────────
test('loadRetentionConfig: safe defaults + env overrides + bad-value fallback', () => {
  const def = loadRetentionConfig({});
  assert.equal(def.enabled, true);
  assert.equal(def.messagesRetentionDays, 90);
  assert.equal(def.jobsRetentionDays, 14);
  assert.equal(def.dryRun, false);

  const custom = loadRetentionConfig({
    STABILITY_CLEANUP_ENABLED: 'false',
    STABILITY_MESSAGES_RETENTION_DAYS: '30',
    STABILITY_CLEANUP_DRY_RUN: 'true',
    STABILITY_CLEANUP_BATCH_SIZE: 'garbage', // → fallback
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.messagesRetentionDays, 30);
  assert.equal(custom.dryRun, true);
  assert.equal(custom.batchSize, 500);
});

// ── Fake db harness ──────────────────────────────────────────────────────────
function makeFakeDb(handlers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const h of handlers) {
        if (h.match.test(sql)) return h.respond(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
    countMatching(re) { return calls.filter((c) => re.test(c.sql)).length; },
  };
}
const lockHandlers = (locked = true) => ([
  { match: /pg_try_advisory_lock/, respond: () => ({ rows: [{ locked }] }) },
  { match: /pg_advisory_unlock/, respond: () => ({ rows: [{}] }) },
  { match: /pg_database_size/, respond: () => ({ rows: [{ bytes: 12345 }] }) },
]);

// ── Orchestration behavior ────────────────────────────────────────────────────
test('runRetentionSweep: disabled → does nothing, issues no queries', async () => {
  const db = makeFakeDb();
  const res = await runRetentionSweep({ db, config: loadRetentionConfig({ STABILITY_CLEANUP_ENABLED: 'false' }), logger: {}, now: NOW });
  assert.equal(res.skipped, 'disabled');
  assert.equal(db.calls.length, 0);
});

test('runRetentionSweep: lock held by another instance → skips, no DELETE', async () => {
  const db = makeFakeDb(lockHandlers(false));
  const res = await runRetentionSweep({ db, config: loadRetentionConfig({}), logger: {}, now: NOW });
  assert.equal(res.skipped, 'locked');
  assert.equal(db.countMatching(/DELETE FROM/i), 0);
  assert.equal(db.countMatching(/pg_advisory_unlock/), 0); // never acquired → nothing to release
});

test('runRetentionSweep: dry-run counts but issues NO DELETE, and releases lock', async () => {
  const db = makeFakeDb([
    ...lockHandlers(true),
    { match: /count\(\*\)/i, respond: () => ({ rows: [{ c: 42 }] }) },
  ]);
  const res = await runRetentionSweep({ db, config: loadRetentionConfig({ STABILITY_CLEANUP_DRY_RUN: 'true' }), logger: {}, now: NOW });
  assert.equal(res.dryRun, true);
  assert.equal(db.countMatching(/DELETE FROM/i), 0, 'dry-run must not delete');
  assert.equal(db.countMatching(/ANALYZE/i), 0, 'dry-run must not ANALYZE');
  assert.equal(db.countMatching(/pg_advisory_unlock/), 1, 'lock released');
  const msgs = res.tables.find((t) => t.table === 'messages');
  assert.equal(msgs.wouldDelete, 42);
  assert.equal(msgs.deleted, 0);
});

test('runRetentionSweep: real run deletes in batches, stops when drained, ANALYZEs, releases lock', async () => {
  // messages: two full batches then a partial; jobs/sessions: one partial each.
  let msgCall = 0;
  const db = makeFakeDb([
    ...lockHandlers(true),
    { match: /DELETE FROM messages/i, respond: () => { msgCall += 1; return { rowCount: msgCall < 3 ? 500 : 120 }; } },
    { match: /DELETE FROM jobs/i, respond: () => ({ rowCount: 7 }) },
    { match: /DELETE FROM app_sessions/i, respond: () => ({ rowCount: 0 }) },
  ]);
  const res = await runRetentionSweep({ db, config: loadRetentionConfig({ STABILITY_CLEANUP_BATCH_DELAY_MS: '0' }), logger: {}, now: NOW });
  const msgs = res.tables.find((t) => t.table === 'messages');
  assert.equal(msgs.deleted, 500 + 500 + 120);
  assert.equal(msgs.batches, 3, 'stops after the partial batch');
  assert.equal(db.countMatching(/DELETE FROM messages/i), 3);
  assert.equal(db.countMatching(/ANALYZE/i), 3, 'ANALYZE messages/jobs/app_sessions');
  assert.equal(db.countMatching(/pg_advisory_unlock/), 1);
  assert.equal(res.sizeBefore, 12345);
  assert.equal(res.sizeAfter, 12345);
});

test('runRetentionSweep: an error mid-sweep still releases the advisory lock', async () => {
  const db = makeFakeDb([
    ...lockHandlers(true),
    { match: /DELETE FROM messages/i, respond: () => { throw new Error('boom'); } },
  ]);
  const res = await runRetentionSweep({ db, config: loadRetentionConfig({}), logger: {}, now: NOW });
  assert.equal(res.error, 'boom');
  assert.equal(db.countMatching(/pg_advisory_unlock/), 1, 'lock released even on failure');
});

// ── The DELETE SQL itself encodes the safety invariants ──────────────────────
test('delete SQL targets only terminal statuses + age cutoff (never in-flight)', () => {
  const m = messagesSpec('2020-01-01T00:00:00.000Z');
  assert.match(m.deleteSql, /status = ANY\(\$2::text\[\]\)/);
  assert.match(m.deleteSql, /created_at < \$1/);
  assert.match(m.deleteSql, /LIMIT \$3/);
  // in-flight statuses must not appear anywhere in the delete params
  const flat = JSON.stringify(m.deleteParams(500));
  for (const s of MESSAGE_INFLIGHT_STATUSES) assert.doesNotMatch(flat, new RegExp(s));

  const j = jobsSpec('2020-01-01T00:00:00.000Z');
  assert.match(j.deleteSql, /status = ANY\(\$1::text\[\]\)/);
  assert.match(j.deleteSql, /LIMIT \$3/);
});

test('ensureRetentionIndexes: uses CONCURRENTLY + IF NOT EXISTS and swallows errors', async () => {
  const db = makeFakeDb([{ match: /CREATE INDEX/i, respond: () => { throw new Error('locked'); } }]);
  await ensureRetentionIndexes(db, {}); // must not throw
  assert.equal(db.countMatching(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/i), 2);
});
