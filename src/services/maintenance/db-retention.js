'use strict';

// ── Phase 1: DB retention & cleanup ─────────────────────────────────────────
// Bounds the unbounded growth of `messages` and `jobs` (root cause of the
// 2026-07-07 disk-full outage). Additive, env-gated, safe, reversible.
//
// Safety invariants (enforced by pure helpers AND by the SQL WHERE clauses):
//   • NEVER delete in-flight messages (queued_for_ai / queued_for_send).
//   • NEVER delete non-terminal jobs (queued / active / pending / retrying …).
//   • NEVER delete rows newer than the retention window.
//   • Only TERMINAL rows older than the window are eligible.
// Operational safety:
//   • Small batches (no huge DELETE inside one long transaction).
//   • Postgres advisory lock → at most one cleanup runs at a time (cross-process).
//   • dry-run mode reports what WOULD be deleted without deleting.
//   • Fully env-configurable with conservative defaults; disable = env flag.
//
// NOTE on disk space: DELETE + autovacuum keeps the tables at a bounded steady
// state (space is reused, growth stops). Returning space to the OS needs a
// separate manual VACUUM FULL (locks) and is intentionally NOT done here.

const MESSAGE_TERMINAL_STATUSES = ['answered_by_ai', 'ai_failed', 'sent', 'send_failed', 'expired', 'stored'];
const MESSAGE_INFLIGHT_STATUSES = ['queued_for_ai', 'queued_for_send'];
const JOB_TERMINAL_STATUSES = ['completed', 'failed', 'canceled', 'expired'];

// Stable arbitrary key for pg_advisory_lock (single-instance guard).
const ADVISORY_LOCK_KEY = 902734101;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,   // every 6h
  messagesRetentionDays: 90,
  jobsRetentionDays: 14,
  batchSize: 500,
  maxBatchesPerRun: 200,            // hard ceiling per run (≤100k rows/run at 500)
  batchDelayMs: 100,                // breathe between batches
  dryRun: false,
  runAnalyze: true,
};

function envInt(env, key, def) {
  const v = parseInt(env[key], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
function envBool(env, key, def) {
  const v = env[key];
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function loadRetentionConfig(env = process.env) {
  return {
    enabled: envBool(env, 'STABILITY_CLEANUP_ENABLED', DEFAULTS.enabled),
    intervalMs: envInt(env, 'STABILITY_CLEANUP_INTERVAL_MS', DEFAULTS.intervalMs) || DEFAULTS.intervalMs,
    messagesRetentionDays: envInt(env, 'STABILITY_MESSAGES_RETENTION_DAYS', DEFAULTS.messagesRetentionDays),
    jobsRetentionDays: envInt(env, 'STABILITY_JOBS_RETENTION_DAYS', DEFAULTS.jobsRetentionDays),
    batchSize: envInt(env, 'STABILITY_CLEANUP_BATCH_SIZE', DEFAULTS.batchSize) || DEFAULTS.batchSize,
    maxBatchesPerRun: envInt(env, 'STABILITY_CLEANUP_MAX_BATCHES', DEFAULTS.maxBatchesPerRun) || DEFAULTS.maxBatchesPerRun,
    batchDelayMs: envInt(env, 'STABILITY_CLEANUP_BATCH_DELAY_MS', DEFAULTS.batchDelayMs),
    dryRun: envBool(env, 'STABILITY_CLEANUP_DRY_RUN', DEFAULTS.dryRun),
    runAnalyze: envBool(env, 'STABILITY_CLEANUP_ANALYZE', DEFAULTS.runAnalyze),
  };
}

// ── Pure decision helpers (behaviorally testable with real row objects) ──────
function isMessageDeletable(row, cutoffMs) {
  if (!row || typeof row.status !== 'string') return false;
  if (MESSAGE_INFLIGHT_STATUSES.includes(row.status)) return false;   // never in-flight
  if (!MESSAGE_TERMINAL_STATUSES.includes(row.status)) return false;  // unknown → keep (conservative)
  const created = new Date(row.created_at).getTime();
  if (!Number.isFinite(created)) return false;
  return created < cutoffMs;                                          // only older than window
}
function isJobDeletable(row, cutoffMs) {
  if (!row || typeof row.status !== 'string') return false;
  if (!JOB_TERMINAL_STATUSES.includes(row.status)) return false;      // keep anything not terminal
  const ref = row.finished_at || row.updated_at || row.created_at;
  const ts = new Date(ref).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts < cutoffMs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tryAcquireLock(db) {
  const res = await db.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
  return res && res.rows && res.rows[0] && res.rows[0].locked === true;
}
async function releaseLock(db) {
  try { await db.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch (_) { /* best-effort */ }
}
async function dbSizeBytes(db) {
  try {
    const r = await db.query('SELECT pg_database_size(current_database()) AS bytes');
    const n = Number(r && r.rows && r.rows[0] && r.rows[0].bytes);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

// Table sweep specs — the WHERE clauses are the second line of defense for the
// safety invariants (terminal statuses + age cutoff only).
function messagesSpec(cutoffIso) {
  return {
    name: 'messages',
    countSql: `SELECT count(*)::bigint AS c FROM messages
                WHERE created_at < $1 AND status = ANY($2::text[])`,
    countParams: [cutoffIso, MESSAGE_TERMINAL_STATUSES],
    deleteSql: `DELETE FROM messages
                 WHERE id IN (
                   SELECT id FROM messages
                    WHERE created_at < $1 AND status = ANY($2::text[])
                    ORDER BY created_at ASC
                    LIMIT $3)`,
    deleteParams: (batch) => [cutoffIso, MESSAGE_TERMINAL_STATUSES, batch],
  };
}
function jobsSpec(cutoffIso) {
  return {
    name: 'jobs',
    countSql: `SELECT count(*)::bigint AS c FROM jobs
                WHERE status = ANY($1::text[])
                  AND COALESCE(finished_at, updated_at, created_at) < $2`,
    countParams: [JOB_TERMINAL_STATUSES, cutoffIso],
    deleteSql: `DELETE FROM jobs
                 WHERE id IN (
                   SELECT id FROM jobs
                    WHERE status = ANY($1::text[])
                      AND COALESCE(finished_at, updated_at, created_at) < $2
                    ORDER BY COALESCE(finished_at, updated_at, created_at) ASC
                    LIMIT $3)`,
    deleteParams: (batch) => [JOB_TERMINAL_STATUSES, cutoffIso, batch],
  };
}
function sessionsSpec() {
  return {
    name: 'app_sessions',
    countSql: `SELECT count(*)::bigint AS c FROM app_sessions WHERE expire <= NOW()`,
    countParams: [],
    deleteSql: `DELETE FROM app_sessions
                 WHERE sid IN (SELECT sid FROM app_sessions WHERE expire <= NOW() LIMIT $1)`,
    deleteParams: (batch) => [batch],
  };
}

async function sweepTable(db, config, spec) {
  if (config.dryRun) {
    const r = await db.query(spec.countSql, spec.countParams);
    const wouldDelete = Number(r && r.rows && r.rows[0] && r.rows[0].c) || 0;
    return { table: spec.name, wouldDelete, deleted: 0, batches: 0 };
  }
  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < config.maxBatchesPerRun; i++) {
    const r = await db.query(spec.deleteSql, spec.deleteParams(config.batchSize));
    const n = (r && typeof r.rowCount === 'number') ? r.rowCount : 0;
    deleted += n;
    batches += 1;
    if (n < config.batchSize) break;          // drained
    if (config.batchDelayMs) await sleep(config.batchDelayMs);
  }
  return { table: spec.name, wouldDelete: 0, deleted, batches };
}

// Best-effort: create retention indexes CONCURRENTLY (never inside a txn, never
// blocking writes). Idempotent (IF NOT EXISTS). Failures are logged, not fatal.
async function ensureRetentionIndexes(db, logger = console) {
  const stmts = [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_status_created ON messages (status, created_at)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_status_finished ON jobs (status, finished_at)`,
  ];
  for (const sql of stmts) {
    try { await db.query(sql); }
    catch (err) { if (logger && logger.warn) logger.warn(`[db-retention] index skipped: ${err.message}`); }
  }
}

async function runRetentionSweep({ db, config = loadRetentionConfig(), logger = console, now = Date.now() } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('db dependency required');
  if (!config.enabled) return { skipped: 'disabled' };

  const msgCutoff = new Date(now - config.messagesRetentionDays * DAY_MS).toISOString();
  const jobsCutoff = new Date(now - config.jobsRetentionDays * DAY_MS).toISOString();

  const locked = await tryAcquireLock(db);
  if (!locked) {
    if (logger && logger.info) logger.info('[db-retention] lock held by another instance — skipping this run');
    return { skipped: 'locked' };
  }

  const summary = { dryRun: config.dryRun, tables: [], sizeBefore: null, sizeAfter: null, durationMs: 0, error: null };
  const started = Date.now();
  try {
    summary.sizeBefore = await dbSizeBytes(db);
    summary.tables.push(await sweepTable(db, config, messagesSpec(msgCutoff)));
    summary.tables.push(await sweepTable(db, config, jobsSpec(jobsCutoff)));
    summary.tables.push(await sweepTable(db, config, sessionsSpec()));
    if (!config.dryRun && config.runAnalyze) {
      for (const t of ['messages', 'jobs', 'app_sessions']) {
        try { await db.query(`ANALYZE ${t}`); } catch (_) { /* non-fatal */ }
      }
    }
    summary.sizeAfter = await dbSizeBytes(db);
  } catch (err) {
    summary.error = err.message;
    if (logger && logger.error) logger.error(`[db-retention] sweep failed: ${err.message}`);
  } finally {
    await releaseLock(db);
    summary.durationMs = Date.now() - started;
  }

  if (logger && logger.info) {
    logger.info(`[db-retention] ${config.dryRun ? 'DRY-RUN ' : ''}complete ${JSON.stringify({
      tables: summary.tables, sizeBefore: summary.sizeBefore, sizeAfter: summary.sizeAfter, ms: summary.durationMs, error: summary.error,
    })}`);
  }
  return summary;
}

// Periodic loop (mirrors startAiRecoveryLoop). Env-gated. Returns the timer (or
// null when disabled) so the caller can clear it on shutdown.
function startRetentionLoop({ db, logger = console } = {}) {
  const config = loadRetentionConfig();
  if (!config.enabled) {
    if (logger && logger.info) logger.info('[db-retention] disabled (STABILITY_CLEANUP_ENABLED=false)');
    return null;
  }
  // Ensure indexes once (best-effort, async, non-blocking to boot).
  ensureRetentionIndexes(db, logger).catch(() => {});
  const run = () => runRetentionSweep({ db, config, logger }).catch((err) => {
    if (logger && logger.error) logger.error(`[db-retention] loop error: ${err.message}`);
  });
  // Small initial delay so it never competes with boot/migrations.
  const warmup = setTimeout(run, 60000);
  if (typeof warmup.unref === 'function') warmup.unref();
  const timer = setInterval(run, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  loadRetentionConfig,
  isMessageDeletable,
  isJobDeletable,
  runRetentionSweep,
  ensureRetentionIndexes,
  startRetentionLoop,
  messagesSpec,
  jobsSpec,
  sessionsSpec,
  MESSAGE_TERMINAL_STATUSES,
  MESSAGE_INFLIGHT_STATUSES,
  JOB_TERMINAL_STATUSES,
  ADVISORY_LOCK_KEY,
  DEFAULTS,
};
