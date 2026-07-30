'use strict';

// Behavioral tests for Phase 2 storage monitoring. A fake db returns a
// programmed pg_database_size so we assert the real threshold behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkStorage, collectHealthChecks } = require('../src/services/monitoring/health-checks');

const GIB = 1024 * 1024 * 1024;

function dbWithSize(bytes, { configured = true } = {}) {
  return {
    isConfigured: () => configured,
    async ping() { return true; },
    async query(sql) {
      if (/pg_database_size/.test(sql)) return { rows: [{ bytes }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('checkStorage: no cap configured → reports size, does NOT alarm', async () => {
  const res = await checkStorage({ database: dbWithSize(2 * GIB), env: {} });
  assert.equal(res.ok, true);
  assert.match(res.detail, /2\.00GB/);
  assert.match(res.detail, /STABILITY_DB_SIZE_CAP_GB/);
});

test('checkStorage: below warning threshold → ok', async () => {
  const res = await checkStorage({ database: dbWithSize(5 * GIB), env: { STABILITY_DB_SIZE_CAP_GB: '10' } }); // 50%
  assert.equal(res.ok, true);
  assert.equal(res.meta.pct, 50);
});

test('checkStorage: between warn and critical → ok=false, severity=warning', async () => {
  const res = await checkStorage({ database: dbWithSize(7.5 * GIB), env: { STABILITY_DB_SIZE_CAP_GB: '10' } }); // 75%
  assert.equal(res.ok, false);
  assert.equal(res.severity, 'warning');
  assert.equal(res.meta.pct, 75);
});

test('checkStorage: at/above critical → ok=false, severity=critical (fires before full)', async () => {
  const res = await checkStorage({ database: dbWithSize(9 * GIB), env: { STABILITY_DB_SIZE_CAP_GB: '10' } }); // 90%
  assert.equal(res.ok, false);
  assert.equal(res.severity, 'critical');
  assert.match(res.detail, /حرج/);
});

test('checkStorage: custom thresholds via env are honored', async () => {
  const env = { STABILITY_DB_SIZE_CAP_GB: '10', STABILITY_DB_WARN_PCT: '50', STABILITY_DB_CRITICAL_PCT: '60' };
  assert.equal((await checkStorage({ database: dbWithSize(5.5 * GIB), env })).severity, 'warning'); // 55%
  assert.equal((await checkStorage({ database: dbWithSize(6.5 * GIB), env })).severity, 'critical'); // 65%
});

test('checkStorage: a size-query error never raises a false alarm (ok=true)', async () => {
  const db = { isConfigured: () => true, async query() { throw new Error('db blip'); } };
  const res = await checkStorage({ database: db, env: { STABILITY_DB_SIZE_CAP_GB: '10' } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /تعذّر/);
});

test('checkStorage: DATABASE_URL unset → ok=true, no alarm', async () => {
  const res = await checkStorage({ database: dbWithSize(9 * GIB, { configured: false }), env: { STABILITY_DB_SIZE_CAP_GB: '10' } });
  assert.equal(res.ok, true);
});

test('collectHealthChecks: includes the storage check when the DB is up', async () => {
  const database = dbWithSize(1 * GIB);
  const redisModule = { getRedisUrl: () => 'redis://x', pingShared: async () => 'PONG' };
  const checks = await collectHealthChecks({ database, redisModule });
  assert.ok(checks.find((c) => c.key === 'storage'), 'storage check present');
});

test('collectHealthChecks: skips storage when the DB is down (avoids noise)', async () => {
  const database = { isConfigured: () => true, async ping() { throw new Error('down'); }, async query() { throw new Error('down'); } };
  const redisModule = { getRedisUrl: () => 'redis://x', pingShared: async () => 'PONG' };
  const checks = await collectHealthChecks({ database, redisModule });
  assert.equal(checks.find((c) => c.key === 'database').ok, false);
  assert.equal(checks.find((c) => c.key === 'storage'), undefined);
});
