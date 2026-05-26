'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// Minimal RuntimeBot stub that wires only the 440-recovery logic
class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.status = 'stopped';
    this.qr = null;
  }
  state() { return { status: this.status }; }
  async start() { this.status = 'waiting_qr'; return true; }
}

function makeBot({ desiredState = 'running' } = {}) {
  const conn = new FakeConnection();
  const startCalls = [];
  const bot = {
    connection: conn,
    sessionDesiredState: desiredState,
    _autoRecoverTimer: null,
    _leaseRenewTimer: null,
    logger: { info: () => {}, warn: () => {} },
    leaseTtlMs() { return 1000; }, // short TTL for test
    startBot(reason) {
      startCalls.push(reason);
      return Promise.resolve(true);
    },
    scheduleLeaseRetry() {},
  };

  // Attach the handler under test (same logic as RuntimeBot constructor)
  conn.on('connection_conflict', () => {
    if (bot.sessionDesiredState !== 'running') return;
    const retryMs = bot.leaseTtlMs() + 200; // +200ms buffer in test
    clearTimeout(bot._autoRecoverTimer);
    bot._autoRecoverTimer = setTimeout(() => {
      bot._autoRecoverTimer = null;
      if (bot.sessionDesiredState === 'running' && bot.connection.status === 'stopped') {
        bot.startBot('440_recovery').catch(() => {});
      }
    }, retryMs);
    if (typeof bot._autoRecoverTimer.unref === 'function') bot._autoRecoverTimer.unref();
  });

  return { bot, conn, startCalls };
}

test('440 schedules auto-recovery when desired state is running', async (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  assert.equal(startCalls.length, 0, 'should not start immediately');

  // Advance past leaseTtlMs (1000) + buffer (200)
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0], '440_recovery');
});

test('440 does NOT schedule recovery when desired state is stopped', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { conn, startCalls } = makeBot({ desiredState: 'stopped' });

  conn.emit('connection_conflict', {});
  t.mock.timers.tick(5000);
  assert.equal(startCalls.length, 0, 'must not auto-recover when owner stopped the bot');
});

test('440 recovery is cancelled if desired state changes to stopped before timer fires', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  bot.sessionDesiredState = 'stopped'; // owner stops the bot manually
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 0, 'must not restart if owner stopped in the meantime');
});

test('440 recovery is cancelled if bot is no longer stopped before timer fires', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  bot.connection.status = 'connected'; // recovered by other means
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 0, 'must not restart if already connected');
});
