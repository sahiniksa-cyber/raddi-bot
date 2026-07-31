'use strict';

// Behavioral tests for Phase 7: detecting a half-open/zombie socket (readyState
// OPEN but no inbound traffic) via the active-liveness helper, WITHOUT
// reconnecting a normally-idle-but-alive socket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { socketIdleExceeded, BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

const NOW = 2_000_000_000_000;

test('socketIdleExceeded: silent longer than idleMaxMs while ready → stale (zombie)', () => {
  assert.equal(socketIdleExceeded({ ready: true, lastActivityAt: NOW - 120000, now: NOW, idleMaxMs: 90000 }), true);
});

test('socketIdleExceeded: recent keepalive traffic → NOT stale (healthy idle link)', () => {
  // Baileys keepalive (~20s) refreshes activity; 30s ago is well within 90s.
  assert.equal(socketIdleExceeded({ ready: true, lastActivityAt: NOW - 30000, now: NOW, idleMaxMs: 90000 }), false);
});

test('socketIdleExceeded: not ready → never stale (no false reconnect while connecting)', () => {
  assert.equal(socketIdleExceeded({ ready: false, lastActivityAt: NOW - 999999, now: NOW, idleMaxMs: 90000 }), false);
});

test('socketIdleExceeded: disabled (idleMaxMs<=0) or bad input → never stale', () => {
  assert.equal(socketIdleExceeded({ ready: true, lastActivityAt: NOW - 999999, now: NOW, idleMaxMs: 0 }), false);
  assert.equal(socketIdleExceeded({ ready: true, lastActivityAt: NaN, now: NOW, idleMaxMs: 90000 }), false);
  assert.equal(socketIdleExceeded({}), false);
});

test('manager tracks last activity and clears it forward on a connection.update', async () => {
  const m = new BaileysConnectionManager({
    userId: 'u1', dataDir: __dirname, database: {}, logger: { info() {}, warn() {}, error() {} },
  });
  m._running = true;
  m._socketGeneration = 1;
  const before = Date.now();
  m._lastActivityAt = before - 500000; // pretend it went stale
  // a benign connection.update (no connection field) must refresh proof-of-life
  await m.handleConnectionUpdate({ someEvent: true }, 0, 1);
  assert.ok(m._lastActivityAt >= before, 'activity clock advanced on the update');
});
