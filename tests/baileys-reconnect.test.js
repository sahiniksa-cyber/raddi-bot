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

test('a successful connection resets the backoff counter so the next reconnect retries fast', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 1;
  manager._retryCount = 5;
  manager.sock = {
    user: { id: '966500000000:1@s.whatsapp.net' },
    end: () => {},
    ws: { close: () => {} },
  };
  manager.client = { sendMessage: async () => {} };

  await manager.handleConnectionUpdate({ connection: 'open' }, 5, 1);

  assert.equal(manager.status, 'connected');
  assert.equal(manager._retryCount, 0, 'backoff index must reset after a successful connection');

  manager.stopHeartbeat();
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
