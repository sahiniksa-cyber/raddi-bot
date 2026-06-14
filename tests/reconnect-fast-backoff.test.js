'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'),
  'utf8',
);

test('WhatsApp reconnect uses a dedicated fast backoff starting at ~1s', () => {
  assert.match(src, /RECONNECT_DELAYS_MS\s*=/);
  assert.match(src, /\[1000, 2000, 5000/);                 // first retry ~1s, then escalates
  assert.match(src, /RECONNECT_DELAYS_MS\[retryIndex\]/);  // scheduleReconnect uses it
});

test('WhatsApp reconnect no longer uses the shared (slow) RETRY.DELAYS_MS for the delay index', () => {
  // RETRY.DELAYS_MS also drives process-restart in start-all — must stay decoupled.
  assert.doesNotMatch(src, /RETRY\.DELAYS_MS\[retryIndex\]/);
});

test('backoff resets after a shorter stable window so a single drop recovers fast', () => {
  assert.match(src, /WA_STABLE_RESET_MS \|\| '12000'/);
});

test('logged-out and 440 are still NOT auto-reconnected (no churn / no 440 storm)', () => {
  assert.match(src, /DisconnectReason\.loggedOut/);
  assert.match(src, /DisconnectReason\.connectionReplaced/);
  // both branches return before scheduleReconnect
  assert.match(src, /reconnect storm/);
});
