'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOutgoingSettleMs,
  shouldCancelOutgoingForStoppedBot,
  waitForConnectedBot,
} = require('../src/workers/outgoing-whatsapp-worker');

test('waitForConnectedBot does not start WhatsApp when owner stopped the bot', async () => {
  let startCalls = 0;
  const bot = {
    sessionDesiredState: 'stopped',
    appState: { status: 'stopped' },
    client: null,
    startBot: async () => { startCalls++; },
  };

  await assert.rejects(
    waitForConnectedBot(bot, { reason: 'test', timeoutMs: 1 }),
    /stopped by owner/,
  );
  assert.equal(startCalls, 0);
});

test('waitForConnectedBot sends as soon as a Baileys bot settles instead of waiting 20s', async () => {
  const prev = process.env.OUTGOING_CONNECTED_SETTLE_MS;
  delete process.env.OUTGOING_CONNECTED_SETTLE_MS;
  try {
    let startCalls = 0;
    const bot = {
      sessionDesiredState: 'running',
      client: { sendMessage: async () => {} },
      appState: { status: 'connected', statusAgeMs: 3500, whatsappEngine: 'baileys' },
      startBot: async () => { startCalls++; },
    };

    const result = await waitForConnectedBot(bot, { reason: 'test', timeoutMs: 1000 });
    assert.equal(result, bot);
    assert.equal(startCalls, 0);
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_CONNECTED_SETTLE_MS;
    else process.env.OUTGOING_CONNECTED_SETTLE_MS = prev;
  }
});

test('resolveOutgoingSettleMs is short for Baileys and long for whatsapp-web by default', () => {
  const prev = process.env.OUTGOING_CONNECTED_SETTLE_MS;
  delete process.env.OUTGOING_CONNECTED_SETTLE_MS;
  try {
    assert.equal(resolveOutgoingSettleMs({ appState: { whatsappEngine: 'baileys' } }), 3000);
    assert.equal(resolveOutgoingSettleMs({ appState: { whatsappEngine: 'whatsapp-web' } }), 20000);
    process.env.OUTGOING_CONNECTED_SETTLE_MS = '1234';
    assert.equal(resolveOutgoingSettleMs({ appState: { whatsappEngine: 'baileys' } }), 1234);
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_CONNECTED_SETTLE_MS;
    else process.env.OUTGOING_CONNECTED_SETTLE_MS = prev;
  }
});

test('shouldCancelOutgoingForStoppedBot cancels normal customer replies only', () => {
  const stoppedBot = { sessionDesiredState: 'stopped' };

  assert.equal(shouldCancelOutgoingForStoppedBot(stoppedBot, { escalation: false }), true);
  assert.equal(shouldCancelOutgoingForStoppedBot(stoppedBot, { escalation: true }), false);
  assert.equal(shouldCancelOutgoingForStoppedBot({ sessionDesiredState: 'running' }, { escalation: false }), false);
});
