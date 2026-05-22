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
  collectHealthChecks,
};
