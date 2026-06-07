'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSocketDeadReadyState } = require('../src/services/whatsapp/baileys-connection-manager');

// WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED.

test('OPEN (1) is alive', () => {
  assert.equal(isSocketDeadReadyState(1), false);
});

test('undefined/null (Baileys build does not expose ws.readyState) is NOT dead', () => {
  // This was the production reconnect-loop bug: the heartbeat read `undefined`
  // on a perfectly healthy connection and forced a reconnect every ~60s.
  assert.equal(isSocketDeadReadyState(undefined), false);
  assert.equal(isSocketDeadReadyState(null), false);
});

test('CONNECTING (0) is not dead (transient)', () => {
  assert.equal(isSocketDeadReadyState(0), false);
});

test('CLOSING (2) and CLOSED (3) are dead', () => {
  assert.equal(isSocketDeadReadyState(2), true);
  assert.equal(isSocketDeadReadyState(3), true);
});
