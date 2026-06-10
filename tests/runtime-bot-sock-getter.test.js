'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');
const { isSocketOpen } = require('../src/workers/outgoing-whatsapp-worker');

test('RuntimeBot exposes a live sock getter delegating to connection.sock', () => {
  const desc = Object.getOwnPropertyDescriptor(RuntimeBot.prototype, 'sock');
  assert.ok(desc && typeof desc.get === 'function', 'RuntimeBot.prototype.sock getter must exist');

  const fakeSock = { ws: { readyState: 1 } };
  assert.equal(desc.get.call({ connection: { sock: fakeSock } }), fakeSock);
  assert.equal(desc.get.call({ connection: {} }), undefined);
});

test('isSocketOpen detects a dead Baileys websocket through the RuntimeBot getter', () => {
  const desc = Object.getOwnPropertyDescriptor(RuntimeBot.prototype, 'sock');
  const botWith = (readyState) => {
    const self = { connection: { sock: { ws: { readyState } } } };
    return { get sock() { return desc.get.call(self); } };
  };

  assert.equal(isSocketOpen(botWith(1)), true);   // OPEN
  assert.equal(isSocketOpen(botWith(3)), false);  // CLOSED — the guard finally works
  assert.equal(isSocketOpen(botWith(0)), false);  // CONNECTING — not safe to send

  // whatsapp-web.js style bot without sock must still be accepted (unchanged)
  assert.equal(isSocketOpen({}), true);
});
