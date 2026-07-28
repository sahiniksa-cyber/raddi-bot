'use strict';

// Safeguards for the 2026-05-31 connection fixes:
// FIX 1 — handleConnectionUpdate tears down the dead socket (removeAllListeners/end/ws.close)
//         and bumps _socketGeneration on loggedOut and connectionReplaced, so the old
//         socket's listeners don't leak and in-flight events are treated as stale.
// FIX 2 — OpenAIMediaAnalyzer no longer falls back to process.env.OPENAI_API_KEY; an
//         empty key returns a safe not-ok result without any network call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DisconnectReason, proto } = require('@whiskeysockets/baileys');
const {
  BaileysConnectionManager,
  shouldSyncEssentialHistoryMessage,
} = require('../src/services/whatsapp/baileys-connection-manager');
const { OpenAIMediaAnalyzer } = require('../src/services/ai/openai-media-analysis');

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

function createFakeSock(calls) {
  return {
    ev: { removeAllListeners: () => calls.push('removeAllListeners') },
    end: () => calls.push('end'),
    ws: { close: () => calls.push('ws.close') },
    user: { id: '' },
  };
}

function makeCloseUpdate(statusCode) {
  return {
    connection: 'close',
    lastDisconnect: {
      error: { message: 'closed', output: { statusCode } },
    },
  };
}

// ---------- FIX 1 ----------

test('FIX 1: loggedOut close tears down the socket and bumps generation', async () => {
  const manager = createManager();
  const calls = [];
  manager._running = true;
  manager._socketGeneration = 5;
  manager.sock = createFakeSock(calls);
  manager.client = {};
  // Avoid touching the DB for auth clearing.
  manager.clearAuthCache = async () => {};

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.loggedOut), 0, 5);

  assert.deepEqual(calls, ['removeAllListeners', 'end', 'ws.close'], 'socket must be torn down in order');
  assert.equal(manager.sock, null, 'sock reference must be cleared');
  assert.equal(manager.client, null, 'client reference must be cleared');
  assert.equal(manager._socketGeneration, 6, 'generation must increment');
  assert.equal(manager._running, false);
  assert.equal(manager.status, 'stopped');
});

test('FIX 1: connectionReplaced (440) close tears down the socket and bumps generation', async () => {
  const manager = createManager();
  const calls = [];
  let conflictEmitted = false;
  manager._running = true;
  manager._socketGeneration = 2;
  manager.sock = createFakeSock(calls);
  manager.client = {};
  manager.on('connection_conflict', () => { conflictEmitted = true; });

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.connectionReplaced), 0, 2);

  assert.deepEqual(calls, ['removeAllListeners', 'end', 'ws.close'], 'socket must be torn down in order');
  assert.equal(manager.sock, null, 'sock reference must be cleared');
  assert.equal(manager.client, null, 'client reference must be cleared');
  assert.equal(manager._socketGeneration, 3, 'generation must increment');
  assert.equal(manager._running, false);
  assert.equal(manager.status, 'stopped');
  assert.ok(conflictEmitted, 'connection_conflict event must still be emitted');
});

test('FIX 1: restartRequired (515) resets QR backoff and schedules the first fast retry', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 9;
  manager._effectiveRetryCount = 15;
  const scheduled = [];
  manager.scheduleReconnect = (retryCount, reason, generation) => {
    scheduled.push({ retryCount, reason, generation });
  };

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.restartRequired), 15, 9);

  assert.equal(manager._effectiveRetryCount, 0, 'QR retries must not delay the post-scan restart');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].retryCount, 0, '515 must use the first ~1 second reconnect slot');
  assert.equal(scheduled[0].generation, 9);
  assert.match(scheduled[0].reason, /code=515/);
});

test('428 (connectionClosed) while awaiting a QR scan refreshes the QR immediately (no dead window)', async () => {
  // Root cause of intermittent link failures: WhatsApp kills an unscanned
  // pre-pairing socket with 428 after ~30s. The generic path let the backoff
  // climb to ~60s, so the QR on screen was DEAD for a full minute and a merchant
  // scanning then got "Check your connection and try again".
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 3;
  manager._effectiveRetryCount = 20; // climbed while the unscanned QR cycled
  manager.status = 'qr_ready';
  const scheduled = [];
  manager.scheduleReconnect = (retryCount, reason, generation) => {
    scheduled.push({ retryCount, reason, generation });
  };

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.connectionClosed), 20, 3);

  assert.equal(manager._effectiveRetryCount, 0, 'the dead-QR backoff must reset so a fresh QR appears immediately');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].retryCount, 0, '428-while-awaiting-scan must reconnect on the first ~1s slot');
  assert.equal(scheduled[0].generation, 3);
  assert.match(scheduled[0].reason, /code=428/);
});

test('428 (connectionClosed) after being connected keeps the normal reconnect backoff', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 3;
  manager._effectiveRetryCount = 4;
  manager.status = 'connected'; // a real mid-session drop, NOT the pre-pairing phase
  const scheduled = [];
  manager.scheduleReconnect = (retryCount, reason, generation) => {
    scheduled.push({ retryCount, reason, generation });
  };

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.connectionClosed), 4, 3);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].retryCount, 4, 'a real drop must use the climbing backoff, not the fast QR-refresh path');
  assert.notEqual(manager._effectiveRetryCount, 0, 'a connected-state 428 must not be treated as a QR refresh');
});

test('FIX 1: pairing keeps identity bootstrap but skips unused heavy history sync types', () => {
  const types = proto.HistorySync.HistorySyncType;
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.INITIAL_BOOTSTRAP }), true);
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.PUSH_NAME }), true);
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.RECENT }), false);
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.FULL }), false);
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.ON_DEMAND }), false);
  assert.equal(shouldSyncEssentialHistoryMessage({ syncType: types.NON_BLOCKING_DATA }), false);
});

test('FIX 1: the last close code and safe auth summary survive later QR rotations', async () => {
  const manager = createManager();
  manager._running = true;
  manager._socketGeneration = 4;
  manager._pairingStartedAt = '2026-07-16T19:48:00.000Z';
  manager._authStore = {
    cache: {
      creds: { registered: true, me: { id: '123@s.whatsapp.net' } },
      keys: { 'pre-key': {}, session: {} },
    },
  };
  manager.scheduleReconnect = () => {};

  await manager.handleConnectionUpdate(makeCloseUpdate(DisconnectReason.restartRequired), 0, 4);
  await manager.handleConnectionUpdate({ qr: 'next-qr' }, 0, 4);

  assert.equal(manager.lastDisconnect.statusCode, DisconnectReason.restartRequired);
  assert.equal(manager.lastDisconnect.reason, 'restartRequired');
  assert.equal(manager.lastDisconnect.pairingStartedAt, '2026-07-16T19:48:00.000Z');
  assert.deepEqual(manager.lastDisconnect.auth, {
    registered: true,
    hasMe: true,
    keyCategories: 2,
  });
  clearTimeout(manager._qrStuckTimer);
});

// ---------- FIX 2 ----------

test('FIX 2: empty apiKey returns a safe not-ok result without a network call', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const analyzer = new OpenAIMediaAnalyzer({ apiKey: '' });
    assert.equal(analyzer.apiKey, '', 'env fallback must not populate the key');

    // A valid-looking image payload so we get past payload normalization and reach getClient().
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const result = await analyzer.analyze({
      kind: 'image',
      mimeType: 'image/png',
      data: onePixelPng.toString('base64'),
    });

    assert.equal(result.ok, false, 'must return not-ok with no key');
    assert.equal(result.reason, 'missing_openai_key', 'must skip rather than call the API');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('FIX 2: process.env.OPENAI_API_KEY is NOT used as a fallback', () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-owner-secret-should-not-leak';
  try {
    const analyzer = new OpenAIMediaAnalyzer({ apiKey: '' });
    assert.equal(analyzer.apiKey, '', 'owner env key must never become the analyzer key');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('FIX 2: an explicit apiKey is trimmed and used as-is', () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-owner-secret-should-not-leak';
  try {
    const analyzer = new OpenAIMediaAnalyzer({ apiKey: '  sk-customer-key-1234567890  ' });
    assert.equal(analyzer.apiKey, 'sk-customer-key-1234567890', 'explicit key must be trimmed and used');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});
