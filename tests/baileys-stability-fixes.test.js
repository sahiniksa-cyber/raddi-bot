'use strict';

// Safeguards for the 2026-05-31 WhatsApp connection stability fixes:
// C3 — shouldDropStartupBulkBatch gates on _hasEverConnected
// C5 — old socket listeners removed before close on reconnect/stop
// H1 — startQrStuckWatchdog arms after each QR, clears on connect
// H3 — heartbeat observes ws.readyState and reconnects on a dead socket

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

function createManager(overrides = {}) {
  return new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
    ...overrides,
  });
}

// ---------- C3 ----------

test('C3: shouldDropStartupBulkBatch fires on first boot before any connect', () => {
  const manager = createManager();
  manager._hasEverConnected = false;
  // Within startup window
  manager.startupTime = Date.now();
  const candidates = Array.from({ length: 8 }, (_, i) => ({ raw: {}, msg: { from: `s${i}` } }));
  const senders = new Set(candidates.map(c => c.msg.from));
  assert.equal(manager.shouldDropStartupBulkBatch(candidates, senders), true);
});

test('C3: shouldDropStartupBulkBatch is disabled after the first successful connect', () => {
  const manager = createManager();
  manager._hasEverConnected = true;          // mimics post-open state
  manager.startupTime = Date.now();           // still within window
  const candidates = Array.from({ length: 20 }, (_, i) => ({ raw: {}, msg: { from: `s${i}` } }));
  const senders = new Set(candidates.map(c => c.msg.from));
  assert.equal(
    manager.shouldDropStartupBulkBatch(candidates, senders),
    false,
    'after first connect, post-reconnect bursts must be ingested, not dropped',
  );
});

// ---------- C5 ----------

test('C5: stop() removes all socket listeners before ending the socket', async () => {
  const manager = createManager();
  const calls = [];
  manager._running = true;
  manager.sock = {
    ev: { removeAllListeners: () => calls.push('removeAllListeners') },
    end: () => calls.push('end'),
    ws: { close: () => calls.push('ws.close') },
  };
  await manager.stop();
  // removeAllListeners must run BEFORE end and ws.close, so a delayed creds.update
  // can never fire after we've torn down the auth store reference.
  assert.deepEqual(calls, ['removeAllListeners', 'end', 'ws.close']);
});

test('C5: scheduleReconnect removes all socket listeners before ending the socket', () => {
  const manager = createManager();
  const calls = [];
  manager._running = true;
  manager._socketGeneration = 1;
  manager.sock = {
    ev: { removeAllListeners: () => calls.push('removeAllListeners') },
    end: () => calls.push('end'),
    ws: { close: () => calls.push('ws.close') },
  };

  manager.scheduleReconnect(0, 'test reason', 1);

  assert.deepEqual(calls, ['removeAllListeners', 'end', 'ws.close']);
  // tidy up the retry timer so the test process doesn't keep it alive
  clearTimeout(manager._retryTimer);
});

// ---------- H1 ----------

test('H1: a QR update arms the QR-stuck watchdog with the active socket generation', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 7;
  manager.sock = { user: { id: '' } };
  // Make Math.random() deterministic enough that the QR update path runs to completion
  await manager.handleConnectionUpdate({ qr: 'qr-payload-A' }, 0, 7);
  assert.ok(manager._qrStuckTimer, 'qr stuck watchdog must be armed');
  assert.equal(manager.status, 'qr_ready');
  clearTimeout(manager._qrStuckTimer);
  manager._qrStuckTimer = null;
});

test('H1: connection open clears the QR-stuck watchdog', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 3;
  manager.sock = { user: { id: '999999@s.whatsapp.net' }, ws: { readyState: 1 } };

  // First, a QR arrives and arms the timer
  await manager.handleConnectionUpdate({ qr: 'qr-1' }, 0, 3);
  assert.ok(manager._qrStuckTimer, 'qr stuck timer should be armed after QR');

  // Then the connection opens — timer must be cleared
  await manager.handleConnectionUpdate({ connection: 'open' }, 0, 3);
  assert.equal(manager._qrStuckTimer, null, 'qr stuck timer must be cleared on open');
  assert.equal(manager._hasEverConnected, true, 'first-connect gate flips on open');
  manager.stopHeartbeat();
  clearTimeout(manager._stableTimer);
});

test('H1: stop() clears the QR-stuck watchdog', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 1;
  manager.sock = {
    ev: { removeAllListeners: () => {} },
    end: () => {},
    ws: { close: () => {} },
    user: { id: '' },
  };
  await manager.handleConnectionUpdate({ qr: 'qr-1' }, 0, 1);
  assert.ok(manager._qrStuckTimer);
  await manager.stop();
  assert.equal(manager._qrStuckTimer, null, 'stop() must clear the QR-stuck timer');
});

// ---------- H3 ----------

test('H3: heartbeat with a dead socket increments failures and triggers reconnect after threshold', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const manager = createManager();
  manager._running = true;
  manager.ready = true;
  manager._socketGeneration = 1;
  manager.sock = {
    ev: { removeAllListeners: () => {} },
    end: () => {},
    ws: { readyState: 3 /* CLOSED */ },
  };

  manager.startHeartbeat();

  // First tick — failure 1, no reconnect yet (threshold is 2)
  t.mock.timers.tick(30000);
  assert.equal(manager.heartbeatFailures, 1);
  assert.notEqual(manager.status, 'reconnecting');

  // Second tick — failure 2, threshold hit → scheduleReconnect runs
  t.mock.timers.tick(30000);
  assert.ok(manager.heartbeatFailures >= 2);
  assert.equal(manager.status, 'reconnecting', 'dead socket must trigger reconnect at the threshold');

  manager.stopHeartbeat();
  clearTimeout(manager._retryTimer);
});

test('H3: heartbeat with an OPEN socket resets the failure counter', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const manager = createManager();
  manager._running = true;
  manager.ready = true;
  manager.heartbeatFailures = 5; // pretend we had old failures
  manager.sock = { ws: { readyState: 1 /* OPEN */ } };

  manager.startHeartbeat();
  t.mock.timers.tick(30000);
  assert.equal(manager.heartbeatFailures, 0, 'a healthy socket must reset failures');
  manager.stopHeartbeat();
});
