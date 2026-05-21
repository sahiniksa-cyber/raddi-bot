'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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

test('shouldCancelOutgoingForStoppedBot cancels normal customer replies only', () => {
  const stoppedBot = { sessionDesiredState: 'stopped' };

  assert.equal(shouldCancelOutgoingForStoppedBot(stoppedBot, { escalation: false }), true);
  assert.equal(shouldCancelOutgoingForStoppedBot(stoppedBot, { escalation: true }), false);
  assert.equal(shouldCancelOutgoingForStoppedBot({ sessionDesiredState: 'running' }, { escalation: false }), false);
});
