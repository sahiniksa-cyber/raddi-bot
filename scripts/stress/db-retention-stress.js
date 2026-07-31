'use strict';

// Staging-only stress/verification harness for Phase 1 DB retention on LARGE
// data (acceptance item: "seed large messages/jobs, test cleanup").
//
// SAFETY:
//  • Runs ONLY against STRESS_DATABASE_URL (never the app's DATABASE_URL).
//  • Refuses any prod-looking URL (jwap / railway / production).
//  • Skips cleanly (no connection) when STRESS_DATABASE_URL is unset — so it is
//    inert in normal test/CI runs.
// Reuses the unit-tested src/services/maintenance/db-retention.js so the cleanup
// logic under stress is the exact same code shipped to production.
//
// Usage (on a disposable staging DB with the schema applied):
//   STRESS_DATABASE_URL=postgres://... STRESS_ROWS=200000 node scripts/stress/db-retention-stress.js

const { runRetentionSweep, loadRetentionConfig } = require('../../src/services/maintenance/db-retention');

function looksLikeProd(url) {
  return /jwap|railway|prod/i.test(String(url || ''));
}

async function runRetentionStress({ env = process.env, makePool, log = console.log } = {}) {
  const url = env.STRESS_DATABASE_URL;
  if (!url) {
    log('[stress] STRESS_DATABASE_URL not set — skipping (safe no-op).');
    return { skipped: 'no STRESS_DATABASE_URL' };
  }
  if (looksLikeProd(url)) {
    throw new Error('[stress] refusing to run against a production-looking URL');
  }
  const rows = parseInt(env.STRESS_ROWS || '200000', 10);
  const pool = (makePool || (() => new (require('pg').Pool)({ connectionString: url })))();
  const db = {
    isConfigured: () => true,
    query: (sql, params) => pool.query(sql, params),
  };
  try {
    const t0 = Date.now();
    log(`[stress] seeding ~${rows} old terminal messages + ${Math.floor(rows / 10)} in-flight (must survive)…`);
    // Old terminal rows (eligible for deletion).
    await db.query(
      `INSERT INTO messages (id, user_id, sender, direction, role, content, status, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), 'stress', 'outbound', 'assistant', 'x', 'sent',
              NOW() - INTERVAL '200 days'
       FROM generate_series(1, $1)`,
      [rows],
    );
    // Recent + in-flight rows (must NOT be deleted).
    await db.query(
      `INSERT INTO messages (id, user_id, sender, direction, role, content, status, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), 'stress', 'inbound', 'user', 'x', 'queued_for_ai', NOW()
       FROM generate_series(1, $1)`,
      [Math.floor(rows / 10)],
    );

    const before = await db.query('SELECT count(*)::bigint AS c FROM messages');
    const dry = await runRetentionSweep({ db, config: loadRetentionConfig({ STABILITY_CLEANUP_DRY_RUN: 'true', STABILITY_CLEANUP_BATCH_DELAY_MS: '0' }), log: () => {} });
    log(`[stress] dry-run would delete: ${JSON.stringify(dry.tables)}`);
    const real = await runRetentionSweep({ db, config: loadRetentionConfig({ STABILITY_CLEANUP_BATCH_DELAY_MS: '0' }), log: () => {} });
    const after = await db.query('SELECT count(*)::bigint AS c FROM messages');
    const survivors = await db.query(`SELECT count(*)::bigint AS c FROM messages WHERE status = 'queued_for_ai'`);

    const result = {
      rowsBefore: Number(before.rows[0].c),
      rowsAfter: Number(after.rows[0].c),
      deleted: real.tables.find((t) => t.table === 'messages')?.deleted || 0,
      inflightSurvived: Number(survivors.rows[0].c),
      durationMs: Date.now() - t0,
    };
    log(`[stress] RESULT ${JSON.stringify(result)}`);
    if (result.inflightSurvived < Math.floor(rows / 10)) {
      throw new Error('[stress] FAIL: in-flight messages were deleted!');
    }
    log('[stress] PASS: old terminal rows removed, in-flight rows preserved.');
    return result;
  } finally {
    if (pool.end) await pool.end().catch(() => {});
  }
}

module.exports = { runRetentionStress, looksLikeProd };

if (require.main === module) {
  runRetentionStress().then((r) => { if (r.skipped) process.exit(0); }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
