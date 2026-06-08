'use strict';

// PR1 — the outgoing worker must NOT force a reconnect while the bot is backing
// off after a WhatsApp 440 conflict. Forcing bot.startBot() there bypassed the
// smart 440 recovery delay and created a tight reconnect loop (connect → 440 →
// connect → 440 ...). When the bot is NOT backing off, the previous behaviour
// (kick a reconnect for a stopped bot) is preserved.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForConnectedBot } = require('../src/workers/outgoing-whatsapp-worker');

function makeBot({ backingOff }) {
  const startCalls = [];
  return {
    startCalls,
    bot: {
      sessionDesiredState: 'running',
      client: null,
      appState: { status: 'stopped', statusAgeMs: 0, whatsappEngine: 'baileys' },
      isInConnConflictBackoff: () => backingOff,
      startBot: (reason) => { startCalls.push(reason); return Promise.resolve(); },
      log: () => {},
    },
  };
}

test('does NOT call startBot while the bot is in 440 conflict backoff', async () => {
  const { bot, startCalls } = makeBot({ backingOff: true });

  await assert.rejects(
    () => waitForConnectedBot(bot, { reason: 'outgoing:1', timeoutMs: 0 }),
    /not connected/i,
  );
  assert.equal(startCalls.length, 0, 'must not force a reconnect during backoff');
});

test('still calls startBot for a stopped bot that is NOT backing off', async () => {
  const { bot, startCalls } = makeBot({ backingOff: false });

  await assert.rejects(
    () => waitForConnectedBot(bot, { reason: 'outgoing:2', timeoutMs: 0 }),
    /not connected/i,
  );
  assert.equal(startCalls.length, 1, 'normal stopped bot is reconnected as before');
  assert.equal(startCalls[0], 'outgoing:2');
});
