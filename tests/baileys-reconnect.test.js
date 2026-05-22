'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

function createManager() {
  return new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

test('restartRequired (515) reconnects immediately without inflating the backoff or showing reconnecting', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 1;
  manager.status = 'connecting';
  manager.ready = true;
  manager.sock = { end: () => {}, ws: { close: () => {} } };
  manager.client = { sendMessage: async () => {} };

  await manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { message: 'restart required', output: { statusCode: 515 } } },
  }, 0, 1);

  assert.equal(manager.status, 'connecting', 'should stay connecting, not flicker to reconnecting');
  assert.equal(manager.reconnectCount, 0, 'restartRequired must not inflate the reconnect counter');
  assert.ok(manager._retryTimer, 'an immediate reconnect should be scheduled');

  clearTimeout(manager._retryTimer);
});

test('backoff does NOT reset on a brief connection; it resets only after the stability window', async () => {
  const prev = process.env.WA_STABLE_RESET_MS;
  process.env.WA_STABLE_RESET_MS = '15';
  try {
    const manager = createManager();
    manager._running = true;
    manager._socketGeneration = 1;
    manager._retryCount = 4;
    manager.sock = { user: { id: '966500000000:1@s.whatsapp.net' }, end: () => {}, ws: { close: () => {} } };
    manager.client = { sendMessage: async () => {} };

    await manager.handleConnectionUpdate({ connection: 'open' }, 4, 1);
    assert.equal(manager.status, 'connected');
    assert.equal(manager._retryCount, 4, 'a freshly-opened (unproven) connection must not reset the backoff');

    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(manager._retryCount, 0, 'backoff resets once the connection proves stable');

    manager.stopHeartbeat();
    await manager.stop();
  } finally {
    if (prev === undefined) delete process.env.WA_STABLE_RESET_MS;
    else process.env.WA_STABLE_RESET_MS = prev;
  }
});

test('a repeating restartRequired (515) backs off instead of hammering every half-second', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 1;
  manager._retryCount = 2; // already retried, so this 515 is NOT the first post-pairing one
  manager.status = 'connected';
  manager.ready = true;
  manager.sock = { end: () => {}, ws: { close: () => {} } };
  manager.client = { sendMessage: async () => {} };

  await manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { message: 'restart required again', output: { statusCode: 515 } } },
  }, 0, 1);

  assert.equal(manager.status, 'reconnecting', 'a repeating 515 must use normal backoff, not immediate reconnect');
  assert.equal(manager.reconnectCount, 1);

  clearTimeout(manager._retryTimer);
});

test('normal disconnect (428) still uses backoff and increments the reconnect counter', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 1;
  manager.status = 'connected';
  manager.ready = true;
  manager.sock = { end: () => {}, ws: { close: () => {} } };
  manager.client = { sendMessage: async () => {} };

  await manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { message: 'connection closed', output: { statusCode: 428 } } },
  }, 0, 1);

  assert.equal(manager.status, 'reconnecting');
  assert.equal(manager.reconnectCount, 1);

  clearTimeout(manager._retryTimer);
});
