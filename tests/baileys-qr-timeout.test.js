'use strict';

// Regression for the "Invalid QR code" / 408 "QR refs attempts ended" loop.
// Baileys gives subsequent QRs only a 20s life by default, which is too short
// for a merchant to scan, so the link cycles (reconnect_count climbs). We pin
// qrTimeout so every QR (first AND subsequent rotations) stays valid longer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'),
  'utf8',
);

test('makeWASocket sets an env-tunable qrTimeout so QRs do not expire in 20s', () => {
  // Must be passed into the socket config (not just declared elsewhere).
  assert.match(src, /qrTimeout:\s*parseInt\(process\.env\.WA_QR_TIMEOUT_MS\s*\|\|\s*'60000',\s*10\)/);
});

test('the qrTimeout line lives inside the makeWASocket(...) options block', () => {
  const start = src.indexOf('makeWASocket({');
  assert.ok(start > 0, 'makeWASocket call exists');
  // getMessage is the last option in the block; qrTimeout must appear before it.
  const getMsgIdx = src.indexOf('getMessage:', start);
  const qrTimeoutIdx = src.indexOf('qrTimeout:', start);
  assert.ok(qrTimeoutIdx > start && qrTimeoutIdx < getMsgIdx, 'qrTimeout is within the socket options');
});
