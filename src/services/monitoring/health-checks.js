'use strict';

const db = require('../../db/client');
const redis = require('../../queues/redis');

async function checkDatabase(database = db) {
  const base = { key: 'database', component: 'قاعدة البيانات', scope: 'global', severity: 'critical' };
  try {
    if (!database.isConfigured?.()) return { ...base, ok: false, detail: 'DATABASE_URL غير مضبوط' };
    await database.ping();
    return { ...base, ok: true, detail: 'متصلة وتستجيب' };
  } catch (err) {
    return { ...base, ok: false, detail: err.message };
  }
}

async function checkRedis(redisModule = redis) {
  const base = { key: 'redis', component: 'Redis (محرّك الطوابير)', scope: 'global', severity: 'critical' };
  try {
    if (!redisModule.getRedisUrl?.()) return { ...base, ok: false, detail: 'REDIS_URL غير مضبوط' };
    const pong = await (redisModule.pingShared ? redisModule.pingShared() : redisModule.ping());
    const ok = pong === 'PONG';
    return { ...base, ok, detail: ok ? 'متصل ويستجيب' : `استجابة غير متوقعة: ${pong}` };
  } catch (err) {
    return { ...base, ok: false, detail: err.message };
  }
}

async function checkQueues({ getQueues, thresholds = {} } = {}) {
  const base = { key: 'queues', component: 'طوابير المعالجة', scope: 'global', severity: 'warning' };
  if (typeof getQueues !== 'function') return { ...base, ok: true, detail: 'غير مفعّلة' };
  try {
    const queues = getQueues();
    const entries = Object.entries(queues);
    const results = await Promise.all(
      entries.map(([, queue]) => queue.getJobCounts('waiting', 'active', 'delayed', 'failed')),
    );
    const counts = {};
    let backlog = 0;
    let failed = 0;
    entries.forEach(([name], i) => {
      const jobCounts = results[i];
      counts[name] = jobCounts;
      backlog += (jobCounts.waiting || 0) + (jobCounts.active || 0) + (jobCounts.delayed || 0);
      failed += jobCounts.failed || 0;
    });
    const maxBacklog = Number.isFinite(thresholds.backlog) ? thresholds.backlog : 200;
    const maxFailed = Number.isFinite(thresholds.failed) ? thresholds.failed : 50;
    const ok = backlog <= maxBacklog && failed <= maxFailed;
    return { ...base, ok, detail: `قيد الانتظار=${backlog} فاشلة=${failed}`, meta: counts };
  } catch (err) {
    return { ...base, ok: false, detail: err.message };
  }
}

async function checkWhatsappSessions({ database = db, staleMs = parseInt(process.env.MONITOR_WA_STALE_MS || '180000', 10) } = {}) {
  if (!database.isConfigured?.()) return [];
  const result = await database.query(
    `SELECT user_id, phone, status, updated_at, last_error
     FROM whatsapp_sessions
     WHERE desired_state = 'running'`,
  );

  const now = Date.now();
  return result.rows.map((row) => {
    const connected = row.status === 'connected';
    const ageMs = row.updated_at ? now - new Date(row.updated_at).getTime() : 0;
    // A reconnecting session is normal for a short while; only flag it once it has been
    // stuck off "connected" longer than staleMs.
    const stuck = !connected && ageMs > staleMs;
    return {
      key: `whatsapp:${row.user_id}`,
      component: `واتساب (${row.phone ? '+' + row.phone : row.user_id})`,
      scope: row.user_id,
      severity: 'critical',
      ok: connected || !stuck,
      detail: connected
        ? `متصل${row.phone ? ' +' + row.phone : ''}`
        : `الحالة: ${row.status}${row.last_error ? ' — ' + row.last_error : ''}`,
    };
  });
}

const GIB = 1024 * 1024 * 1024;

// Best-effort largest-tables breakdown (for logs / the owner health endpoint).
async function largestTables(database = db, limit = 5) {
  try {
    const r = await database.query(
      `SELECT relname AS table, pg_total_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT $1`,
      [limit],
    );
    return (r.rows || []).map((row) => ({ table: row.table, bytes: Number(row.bytes) }));
  } catch (_) {
    return [];
  }
}

// Phase 2: DB storage-size check. Opens a warning/critical incident (→ alert)
// BEFORE the volume fills — the early warning that was missing in the
// 2026-07-07 outage. Reports size only (no alert) until a capacity cap is set
// via STABILITY_DB_SIZE_CAP_GB / _BYTES. On any query error it stays ok=true to
// avoid false alarms.
async function checkStorage({ database = db, env = process.env } = {}) {
  const base = { key: 'storage', component: 'مساحة قاعدة البيانات', scope: 'global' };
  try {
    if (!database.isConfigured?.()) return { ...base, severity: 'warning', ok: true, detail: 'DATABASE_URL غير مضبوط' };
    const r = await database.query('SELECT pg_database_size(current_database()) AS bytes');
    const bytes = Number(r?.rows?.[0]?.bytes);
    if (!Number.isFinite(bytes)) return { ...base, severity: 'warning', ok: true, detail: 'تعذّر قياس الحجم' };
    const gb = (bytes / GIB).toFixed(2);

    const capBytesEnv = parseInt(env.STABILITY_DB_SIZE_CAP_BYTES, 10);
    const capGbEnv = parseFloat(env.STABILITY_DB_SIZE_CAP_GB);
    const cap = Number.isFinite(capBytesEnv) && capBytesEnv > 0
      ? capBytesEnv
      : (Number.isFinite(capGbEnv) && capGbEnv > 0 ? Math.round(capGbEnv * GIB) : 0);
    const warnPct = Number.isFinite(parseInt(env.STABILITY_DB_WARN_PCT, 10)) ? parseInt(env.STABILITY_DB_WARN_PCT, 10) : 70;
    const critPct = Number.isFinite(parseInt(env.STABILITY_DB_CRITICAL_PCT, 10)) ? parseInt(env.STABILITY_DB_CRITICAL_PCT, 10) : 85;

    const meta = { bytes, cap };
    if (!cap) {
      return { ...base, severity: 'warning', ok: true, detail: `الحجم ${gb}GB (اضبط STABILITY_DB_SIZE_CAP_GB لتنبيهات النسبة)`, meta };
    }
    const pct = Math.round((bytes / cap) * 100);
    meta.pct = pct;
    if (pct >= critPct) return { ...base, severity: 'critical', ok: false, detail: `قاعدة البيانات ${pct}% (${gb}GB) — حرج: قرب الامتلاء`, meta };
    if (pct >= warnPct) return { ...base, severity: 'warning', ok: false, detail: `قاعدة البيانات ${pct}% (${gb}GB) — تحذير`, meta };
    return { ...base, severity: 'warning', ok: true, detail: `قاعدة البيانات ${pct}% (${gb}GB)`, meta };
  } catch (err) {
    return { ...base, severity: 'warning', ok: true, detail: `تعذّر فحص الحجم: ${err.message}` };
  }
}

async function collectHealthChecks({ database = db, redisModule = redis, getQueues = null, thresholds = {} } = {}) {
  const [database_, redis_, queues_] = await Promise.all([
    checkDatabase(database),
    checkRedis(redisModule),
    checkQueues({ getQueues, thresholds }),
  ]);
  const checks = [database_, redis_, queues_];
  // WhatsApp checks need the DB; skip them when the DB itself is down to avoid noise.
  if (database_.ok) {
    try {
      checks.push(await checkStorage({ database }));
    } catch (_) {
      // storage probe is best-effort; never let it break the health pass.
    }
    try {
      checks.push(...await checkWhatsappSessions({ database }));
    } catch (_) {
      // DB race; the database check already reflects the real problem.
    }
  }
  return checks;
}

module.exports = {
  checkDatabase,
  checkRedis,
  checkQueues,
  checkWhatsappSessions,
  checkStorage,
  largestTables,
  collectHealthChecks,
};
