'use strict';

// Behavioral tests for Phase 3: self-healing from a failed start(). Uses a real
// BaileysConnectionManager instance + node:test mock timers; start() is stubbed
// so we observe the retry orchestration without a real socket/DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

function createManager() {
  return new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: { info() {}, warn() {}, error() {} },
  });
}

test('_classifyStartError: auth/credential failures are permanent; others transient', () => {
  const m = createManager();
  assert.equal(m._classifyStartError(new Error('device logged out')), 'permanent');
  assert.equal(m._classifyStartError(new Error('Unauthorized')), 'permanent');
  assert.equal(m._classifyStartError(new Error('request failed with 401')), 'permanent');
  assert.equal(m._classifyStartError(new Error('getaddrinfo ENOTFOUND web.whatsapp.com')), 'transient');
  assert.equal(m._classifyStartError(new Error('db pool timeout')), 'transient');
});

test('transient start failure schedules a bounded retry (never parks in error)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = createManager();
  m._running = true; // start() set this before throwing
  let starts = 0;
  m.start = async () => { starts += 1; };

  const r = m.scheduleStartRetry(new Error('db blip'), 0);
  assert.equal(r, false);
  assert.equal(m.status, 'reconnecting', 'status is reconnecting, NOT error');
  assert.equal(m._startRetryCount, 1);
  assert.ok(m._retryTimer, 'a retry timer was scheduled');

  t.mock.timers.tick(60000);
  assert.equal(starts, 1, 're-entered start() after backoff');
});

test('single-flight: a second failure while a retry is pending does not stack timers', () => {
  const m = createManager();
  m._running = true;
  m._retryTimer = {}; // simulate an already-pending retry
  const r = m.scheduleStartRetry(new Error('db blip'), 0);
  assert.equal(r, false);
  assert.equal(m._startRetryCount, 0, 'no increment while a retry is already pending');
});

test('permanent failure settles in error for manual intervention (no retry)', () => {
  const m = createManager();
  m._running = true;
  m.scheduleStartRetry(new Error('logged out'), 0);
  assert.equal(m.status, 'error');
  assert.equal(m._running, false);
  assert.equal(m._retryTimer, null);
});

test('exhausted retry ladder settles in error and resets the counter', () => {
  const m = createManager();
  m._running = true;
  m._startRetryCount = 8; // == default STABILITY_START_MAX_RETRIES
  m.scheduleStartRetry(new Error('db blip'), 7);
  assert.equal(m.status, 'error');
  assert.equal(m._startRetryCount, 0);
});

test('stop() cancels a pending start-retry (status → stopped, no start fires)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = createManager();
  m._running = true;
  let starts = 0;
  m.start = async () => { starts += 1; };

  m.scheduleStartRetry(new Error('db blip'), 0);
  assert.ok(m._retryTimer);

  await m.stop();
  assert.equal(m.status, 'stopped');
  assert.equal(m._retryTimer, null);

  t.mock.timers.tick(60000);
  assert.equal(starts, 0, 'no start() after stop()');
});
