'use strict';

// scheduleReconnect must drain the auth-store flush before opening a new socket.
// Without this, key writes still pending in the debounce timer would be lost
// when the new socket starts using a fresh BaileysPostgresAuthState instance —
// surfacing as "Bad MAC" on the very next inbound message until the session
// re-negotiates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('scheduleReconnect awaits the captured authFlush before calling start()', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'),
    'utf8',
  );
  const reconnectMatch = src.match(/scheduleReconnect\([^)]*\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert.ok(reconnectMatch, 'scheduleReconnect method found');
  const body = reconnectMatch[0];
  // Captures this._authFlush BEFORE the setTimeout.
  assert.match(body, /flushBeforeReconnect\s*=\s*this\._authFlush/,
    'must capture _authFlush before the setTimeout callback runs');
  // Awaits the flush inside the timer, before start().
  assert.match(body, /await\s+flushBeforeReconnect\(\)/,
    'must await the flush inside the reconnect callback');
});

test('stop() still flushes the auth store (PR #58 behavior preserved)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'),
    'utf8',
  );
  // The stop() path keeps the existing flush behavior from PR #58.
  assert.match(src, /async\s+stop\s*\(\s*\)\s*\{[\s\S]*?await\s+flush\(\)/m);
});
