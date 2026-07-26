'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diffHealth, summarizeHealth } = require('../src/services/monitoring/incident-tracker');
const { HealthMonitor } = require('../src/services/monitoring/health-monitor');
const { createAlertDispatcher } = require('../src/services/monitoring/alerts');

test('diffHealth opens an incident only on the transition to down', () => {
  const first = diffHealth({}, [{ key: 'database', component: 'DB', ok: false, detail: 'down' }]);
  assert.equal(first.opened.length, 1);
  assert.equal(first.resolved.length, 0);

  const second = diffHealth(first.current, [{ key: 'database', component: 'DB', ok: false, detail: 'still down' }]);
  assert.equal(second.opened.length, 0, 'a still-down component must not re-open');
  assert.equal(second.resolved.length, 0);
});

test('diffHealth resolves an incident when a component recovers', () => {
  const down = diffHealth({}, [{ key: 'redis', component: 'Redis', ok: false, detail: 'down' }]);
  const up = diffHealth(down.current, [{ key: 'redis', component: 'Redis', ok: true, detail: 'ok' }]);
  assert.equal(up.resolved.length, 1);
  assert.equal(up.opened.length, 0);
});

test('summarizeHealth reports overall status and counts', () => {
  const summary = summarizeHealth([
    { key: 'a', ok: true },
    { key: 'b', ok: false, severity: 'critical' },
    { key: 'c', ok: false, severity: 'warning' },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.total, 3);
  assert.equal(summary.downCount, 2);
  assert.equal(summary.criticalDownCount, 1);
});

test('HealthMonitor dispatches alerts once per incident and on recovery', async () => {
  const events = [];
  const dispatcher = { dispatch: async ({ kind, incident }) => { events.push(`${kind}:${incident.key}`); return ['test']; } };

  let dbOk = false;
  const fakeDb = {
    isConfigured: () => true,
    ping: async () => { if (!dbOk) throw new Error('db down'); return { now: 1 }; },
    query: async () => ({ rows: [] }),
  };
  const fakeRedis = { getRedisUrl: () => 'redis://x', ping: async () => 'PONG' };

  const monitor = new HealthMonitor({ database: fakeDb, redisModule: fakeRedis, dispatcher, persist: false, logger: { warn() {}, error() {} } });

  await monitor.runOnce(); // db down -> open
  await monitor.runOnce(); // db still down -> no new alert
  dbOk = true;
  await monitor.runOnce(); // db recovered -> resolved

  assert.deepEqual(events, ['open:database', 'resolved:database']);
});

test('HealthMonitor does not emit a false recovery for WhatsApp when the database drops', async () => {
  const events = [];
  const dispatcher = { dispatch: async ({ kind, incident }) => { events.push(`${kind}:${incident.key}`); return []; } };
  let dbOk = true;
  const staleSession = {
    user_id: 'U', phone: '966500000000', status: 'reconnecting',
    updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), last_error: 'x',
  };
  const fakeDb = {
    isConfigured: () => true,
    ping: async () => { if (!dbOk) throw new Error('db down'); return { now: 1 }; },
    query: async (sql) => (/FROM whatsapp_sessions/.test(sql) ? { rows: [staleSession] } : { rows: [] }),
  };
  const fakeRedis = { getRedisUrl: () => 'redis://x', pingShared: async () => 'PONG' };
  const monitor = new HealthMonitor({ database: fakeDb, redisModule: fakeRedis, dispatcher, persist: false, logger: { warn() {}, error() {} } });

  await monitor.runOnce(); // WhatsApp session stuck -> open whatsapp:U
  dbOk = false;
  await monitor.runOnce(); // DB down -> open database; WhatsApp carried forward, NOT resolved

  assert.ok(events.includes('open:whatsapp:U'));
  assert.ok(events.includes('open:database'));
  assert.ok(!events.includes('resolved:whatsapp:U'), 'must not falsely resolve WhatsApp when DB is down');
});

test('HealthMonitor only dispatches when it wins the incident row (cross-replica lock)', async () => {
  const events = [];
  const dispatcher = { dispatch: async ({ kind, incident }) => { events.push(`${kind}:${incident.key}`); return ['x']; } };
  const fakeDb = {
    isConfigured: () => true,
    ping: async () => { throw new Error('down'); },
    query: async (sql) => {
      if (/INSERT INTO health_incidents/.test(sql)) return { rows: [], rowCount: 0 }; // lost the race
      return { rows: [] };
    },
  };
  const fakeRedis = { getRedisUrl: () => 'redis://x', pingShared: async () => 'PONG' };
  const monitor = new HealthMonitor({ database: fakeDb, redisModule: fakeRedis, dispatcher, persist: true, logger: { warn() {}, error() {} } });

  await monitor.runOnce();
  assert.deepEqual(events, [], 'a process that did not open the incident must not dispatch');
});

test('alert dispatcher skips channels that are not configured without throwing', async () => {
  const dispatcher = createAlertDispatcher({ ownerPhone: '', ownerEmail: '', mailer: null, getOwnerBot: null });
  const channels = await dispatcher.dispatch({ kind: 'open', incident: { component: 'DB', detail: 'down', severity: 'critical' } });
  assert.deepEqual(channels, []);
});

test('alert dispatcher sends WhatsApp to the owner when a connected bot is available', async () => {
  const sent = [];
  const dispatcher = createAlertDispatcher({
    ownerPhone: '+966500000000',
    database: { isConfigured: () => true },
    getOwnerBot: async () => ({
      userId: 'owner-user',
      appState: { status: 'connected' },
      client: {},
    }),
    gatewayFactory: () => ({
      send: async request => {
        sent.push({ jid: request.destination, text: request.content });
        return { decision: 'sent' };
      },
    }),
  });
  const channels = await dispatcher.dispatch({ kind: 'open', incident: { component: 'واتساب', detail: 'down', severity: 'critical' } });
  assert.deepEqual(channels, ['whatsapp']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '966500000000@s.whatsapp.net');
});
