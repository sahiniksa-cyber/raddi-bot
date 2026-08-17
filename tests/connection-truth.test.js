'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyConnectionTruth, isQrRequired, CONNECTION_TRUTH } = require('../src/services/whatsapp/connection-truth');

test('live connected socket → CONNECTED', () => {
  assert.equal(classifyConnectionTruth({ status: 'connected', desiredState: 'running' }), 'CONNECTED');
});

test('connecting / reconnecting are transient, never QR_REQUIRED', () => {
  assert.equal(classifyConnectionTruth({ status: 'connecting', desiredState: 'running' }), 'CONNECTING');
  assert.equal(classifyConnectionTruth({ status: 'reconnecting', desiredState: 'running' }), 'RECONNECTING');
});

test('transient close (428 connectionClosed) while running is DISCONNECTED, not QR_REQUIRED', () => {
  const truth = classifyConnectionTruth({
    status: 'stopped',
    desiredState: 'running',
    lastDisconnect: { statusCode: 428, reason: 'connectionClosed' },
  });
  assert.equal(truth, 'DISCONNECTED');
  assert.equal(isQrRequired(truth), false);
});

test('440 connectionReplaced while running is DISCONNECTED (recoverable), not QR_REQUIRED', () => {
  const truth = classifyConnectionTruth({
    status: 'stopped',
    desiredState: 'running',
    lastDisconnect: { statusCode: 440, reason: 'connectionReplaced' },
  });
  assert.equal(truth, 'DISCONNECTED');
  assert.equal(isQrRequired(truth), false);
});

test('loggedOut (401) while running → QR_REQUIRED (auth wiped, needs new pairing)', () => {
  const byReason = classifyConnectionTruth({
    status: 'stopped',
    desiredState: 'running',
    lastDisconnect: { statusCode: 401, reason: 'loggedOut' },
  });
  assert.equal(byReason, 'QR_REQUIRED');
  assert.equal(isQrRequired(byReason), true);
  // statusCode alone (reason missing) still classifies as terminal.
  const byCode = classifyConnectionTruth({
    status: 'stopped',
    desiredState: 'running',
    lastDisconnect: { statusCode: 401 },
  });
  assert.equal(byCode, 'QR_REQUIRED');
});

test('a session actively showing a QR is QR_REQUIRED', () => {
  assert.equal(classifyConnectionTruth({ status: 'qr_ready', desiredState: 'running' }), 'QR_REQUIRED');
  assert.equal(classifyConnectionTruth({ status: 'waiting_qr', desiredState: 'running' }), 'QR_REQUIRED');
});

test('desiredState=running NEVER by itself yields CONNECTED', () => {
  // The whole point of problem #1: intent is not truth.
  const truth = classifyConnectionTruth({ status: 'stopped', desiredState: 'running' });
  assert.notEqual(truth, 'CONNECTED');
  assert.equal(truth, 'DISCONNECTED');
});

test('stopped intentionally (desiredState=stopped) → STOPPED', () => {
  assert.equal(classifyConnectionTruth({ status: 'stopped', desiredState: 'stopped' }), 'STOPPED');
});

test('error status → ERROR', () => {
  assert.equal(classifyConnectionTruth({ status: 'error', desiredState: 'running' }), 'ERROR');
});

test('CONNECTION_TRUTH exposes the full explicit enum', () => {
  assert.deepEqual(
    Object.keys(CONNECTION_TRUTH).sort(),
    ['CONNECTED', 'CONNECTING', 'DISCONNECTED', 'ERROR', 'QR_REQUIRED', 'RECONNECTING', 'STOPPED'],
  );
});

test('classifier is pure — same input two tenants, independent results (no shared state)', () => {
  const a = classifyConnectionTruth({ status: 'connected', desiredState: 'running' });
  const b = classifyConnectionTruth({ status: 'stopped', desiredState: 'running', lastDisconnect: { statusCode: 401 } });
  assert.equal(a, 'CONNECTED');
  assert.equal(b, 'QR_REQUIRED');
});
