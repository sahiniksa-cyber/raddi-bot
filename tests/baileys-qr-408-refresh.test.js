'use strict';

// Behavioral tests for Phase 6: a pre-pairing socket close while awaiting a QR
// scan must refresh the QR IMMEDIATELY for both 428 (connectionClosed) and 408
// (timedOut/connectionLost). A close AFTER connect still uses normal backoff.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

function createManager() {
  return new BaileysConnectionManager({
    userId: 'user-1', dataDir: __dirname, database: {},
    logger: { info() {}, warn() {}, error() {} },
  });
}

function closeUpdate(statusCode) {
  return { connection: 'close', lastDisconnect: { error: { message: 'closed', output: { statusCode } } } };
}

// Drive a close through the manager while awaiting a scan and capture how the
// reconnect is scheduled (retryCount 0 = immediate refresh).
async function runClose({ status, statusCode, effectiveRetryCount = 5 }) {
  const m = createManager();
  m._running = true;
  m._socketGeneration = 1;
  m.status = status;
  m.ready = status === 'connected';
  m._effectiveRetryCount = effectiveRetryCount;
  const calls = [];
  m.scheduleReconnect = (retryCount, reason, gen) => { calls.push({ retryCount, gen }); };
  await m.handleConnectionUpdate(closeUpdate(statusCode), 0, 1);
  return { m, calls };
}

test('qr_ready + 428 → immediate QR refresh (retry slot 0, backoff reset)', async () => {
  const { m, calls } = await runClose({ status: 'qr_ready', statusCode: 428 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retryCount, 0, 'reconnect scheduled on the first (immediate) slot');
  assert.equal(m._effectiveRetryCount, 0, 'backoff ladder reset');
});

test('qr_ready + 408 (timedOut/connectionLost) → immediate QR refresh (NEW coverage)', async () => {
  const { m, calls } = await runClose({ status: 'qr_ready', statusCode: 408 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retryCount, 0, '408 while awaiting scan now refreshes immediately, not on climbing backoff');
  assert.equal(m._effectiveRetryCount, 0);
});

test('connected + 408 → normal backoff (fast-refresh must NOT hijack a live session)', async () => {
  const { calls } = await runClose({ status: 'connected', statusCode: 408, effectiveRetryCount: 4 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retryCount, 4, 'a post-connect drop keeps its normal backoff');
});
