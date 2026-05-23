'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeOutboundJid } = require('../src/services/whatsapp/baileys-connection-manager');
const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

test('normalizeOutboundJid preserves Baileys LID chat ids', () => {
  assert.equal(
    normalizeOutboundJid('278571713060916@lid'),
    '278571713060916@lid',
  );
});

test('normalizeOutboundJid converts legacy whatsapp-web chat ids to phone JIDs', () => {
  assert.equal(
    normalizeOutboundJid('966501234567@c.us'),
    '966501234567@s.whatsapp.net',
  );
});

function createManager() {
  return new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

test('Baileys manager ignores stale close updates from an older socket generation', async () => {
  const manager = createManager();
  let ended = 0;

  manager._running = true;
  manager._socketGeneration = 2;
  manager.status = 'connected';
  manager.ready = true;
  manager.sock = {
    end: () => { ended++; },
    ws: { close: () => { ended++; } },
  };
  manager.client = { sendMessage: async () => {} };

  await manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: {
      error: { message: 'old socket closed', output: { statusCode: 428 } },
    },
  }, 0, 1);

  assert.equal(manager.status, 'connected');
  assert.equal(manager.ready, true);
  assert.equal(manager.reconnectCount, 0);
  assert.equal(ended, 0);
});

test('Baileys manager schedules only one reconnect for duplicate close updates', async () => {
  const manager = createManager();

  manager._running = true;
  manager._socketGeneration = 1;
  manager.status = 'connected';
  manager.ready = true;
  manager.sock = {
    end: () => {},
    ws: { close: () => {} },
  };
  manager.client = { sendMessage: async () => {} };

  const closeUpdate = {
    connection: 'close',
    lastDisconnect: {
      error: { message: 'connection closed', output: { statusCode: 428 } },
    },
  };

  await manager.handleConnectionUpdate(closeUpdate, 0, 1);
  await manager.handleConnectionUpdate(closeUpdate, 0, 1);

  assert.equal(manager.status, 'reconnecting');
  assert.equal(manager.reconnectCount, 1);

  clearTimeout(manager._retryTimer);
});

test('Baileys manager ignores history sync message batches', async () => {
  const ingested = [];
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ingestService: {
      ingestWhatsappMessage: async (payload) => {
        ingested.push(payload);
        return { accepted: true };
      },
    },
  });

  manager._running = true;

  manager.handleMessages({
    type: 'append',
    messages: [{
      key: { id: 'old-1', remoteJid: '966501234567@s.whatsapp.net' },
      message: { conversation: 'old customer message' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }],
  });

  assert.deepEqual(ingested, []);
});

test('Baileys manager ignores customer messages older than the current startup window', async () => {
  const ingested = [];
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ingestService: {
      ingestWhatsappMessage: async (payload) => {
        ingested.push(payload);
        return { accepted: true };
      },
    },
  });

  manager._running = true;
  manager.acceptMessagesAfterMs = Date.now() - 5_000;

  manager.handleMessages({
    type: 'notify',
    messages: [{
      key: { id: 'old-2', remoteJid: '966501234567@s.whatsapp.net' },
      message: { conversation: 'old customer message' },
      messageTimestamp: Math.floor((Date.now() - 60 * 60 * 1000) / 1000),
    }],
  });

  assert.deepEqual(ingested, []);
});

test('Baileys manager does not reconnect from a stale timer after it is connected', async () => {
  const manager = createManager();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let scheduledCallback = null;
  let startCalls = 0;

  global.setTimeout = (callback) => {
    scheduledCallback = callback;
    return { unref: () => {} };
  };
  global.clearTimeout = () => {};

  try {
    manager._running = true;
    manager._socketGeneration = 1;
    manager.status = 'connected';
    manager.ready = true;
    manager.sock = {
      end: () => {},
      ws: { close: () => {} },
    };
    manager.client = { sendMessage: async () => {} };
    manager.start = async () => {
      startCalls++;
      return true;
    };

    manager.scheduleReconnect(0, 'connectionReplaced', 1);

    manager.status = 'connected';
    manager.ready = true;
    await scheduledCallback();

    assert.equal(startCalls, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
