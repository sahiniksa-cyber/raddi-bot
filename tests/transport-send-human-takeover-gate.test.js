'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaileysClientWrapper } = require('../src/services/whatsapp/baileys-connection-manager');

function makeSock(sent) {
  return {
    user: { id: '111@s.whatsapp.net' },
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'wa-real-1' } }; },
    sendPresenceUpdate: async () => {},
  };
}

// The transport boundary: the wrapper reserves the bot-send id (a DB await) then
// calls the REAL sock.sendMessage. The Human-Takeover gate must sit AFTER the
// reservation and immediately before sock.sendMessage — the closest possible
// point to the actual transport.
test('gate: beforeTransportSend=abort → sock.sendMessage NOT called, but reservation already ran (gate is after it)', async () => {
  const sent = [];
  const reserved = [];
  const wrapper = createBaileysClientWrapper({
    sock: makeSock(sent), isReady: () => true, isReadOnly: () => false, status: () => 'connected',
    reserveBotSend: async (r) => { reserved.push(r); },
  });
  const result = await wrapper.sendMessage('966500000000@s.whatsapp.net', 'مرحبا', {
    beforeTransportSend: async () => true, // paused → abort
  });
  assert.equal(sent.length, 0, 'no real transport send after takeover');
  assert.equal(reserved.length, 1, 'reservation ran before the gate (gate is the LAST step)');
  assert.equal(result.aborted, true);
});

test('reservation race: takeover commits DURING reserveBotSend → gate still blocks the send', async () => {
  const sent = [];
  let paused = false;
  const wrapper = createBaileysClientWrapper({
    sock: makeSock(sent), isReady: () => true, isReadOnly: () => false, status: () => 'connected',
    reserveBotSend: async () => { paused = true; }, // merchant reply lands during the reservation await
  });
  const result = await wrapper.sendMessage('966500000000@s.whatsapp.net', 'مرحبا', {
    beforeTransportSend: async () => paused,
  });
  assert.equal(sent.length, 0, 'send blocked even though takeover landed during the reservation');
  assert.equal(result.aborted, true);
});

test('gate: beforeTransportSend=ok → real send happens exactly once', async () => {
  const sent = [];
  const wrapper = createBaileysClientWrapper({
    sock: makeSock(sent), isReady: () => true, isReadOnly: () => false, status: () => 'connected',
    reserveBotSend: async () => {},
  });
  const result = await wrapper.sendMessage('966500000000@s.whatsapp.net', 'مرحبا', {
    beforeTransportSend: async () => false,
  });
  assert.equal(sent.length, 1);
  assert.ok(result.key);
});

test('no gate provided (campaigns/alerts) → sends normally (opt-in, backward compatible)', async () => {
  const sent = [];
  const wrapper = createBaileysClientWrapper({
    sock: makeSock(sent), isReady: () => true, isReadOnly: () => false, status: () => 'connected',
    reserveBotSend: async () => {},
  });
  await wrapper.sendMessage('966500000000@s.whatsapp.net', 'حملة');
  assert.equal(sent.length, 1);
});
