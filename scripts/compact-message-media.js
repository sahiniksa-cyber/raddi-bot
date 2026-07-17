'use strict';

const db = require('../src/db/client');

const APPLY = process.argv.includes('--apply');
const VACUUM = process.argv.includes('--vacuum');
const BATCH_SIZE = Math.max(50, Math.min(2000, Number.parseInt(process.env.MEDIA_COMPACTION_BATCH_SIZE || '250', 10)));

async function summary() {
  const result = await db.query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(pg_column_size(raw_payload->'media')), 0)::bigint AS bytes
     FROM messages
     WHERE (direction = 'outbound' OR status NOT IN ('queued_for_ai', 'ai_failed'))
       AND (
         NULLIF(raw_payload #>> '{media,data}', '') IS NOT NULL
         OR NULLIF(raw_payload #>> '{media,base64}', '') IS NOT NULL
       )`,
  );
  return {
    rows: Number(result.rows[0]?.rows || 0),
    bytes: Number(result.rows[0]?.bytes || 0),
  };
}

async function compactBatch() {
  const result = await db.query(
    `WITH batch AS (
       SELECT id
       FROM messages
       WHERE (direction = 'outbound' OR status NOT IN ('queued_for_ai', 'ai_failed'))
         AND (
           NULLIF(raw_payload #>> '{media,data}', '') IS NOT NULL
           OR NULLIF(raw_payload #>> '{media,base64}', '') IS NOT NULL
         )
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE messages m
     SET raw_payload = m.raw_payload #- '{media,data}' #- '{media,base64}'
     FROM batch
     WHERE m.id = batch.id
     RETURNING m.id`,
    [BATCH_SIZE],
  );
  return result.rows.length;
}

async function main() {
  const before = await summary();
  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    eligibleRows: before.rows,
    eligibleBytes: before.bytes,
    batchSize: BATCH_SIZE,
  }));
  if (!APPLY || before.rows === 0) return;

  let updated = 0;
  while (true) {
    const count = await compactBatch();
    updated += count;
    if (count < BATCH_SIZE) break;
    console.log(JSON.stringify({ updated }));
  }
  if (VACUUM) await db.query('VACUUM (ANALYZE) messages');
  const after = await summary();
  console.log(JSON.stringify({
    complete: true,
    updated,
    vacuumed: VACUUM,
    remainingRows: after.rows,
    remainingBytes: after.bytes,
  }));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
