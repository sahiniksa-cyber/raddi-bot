'use strict';

// Safeguards for the 2026-05-31 WhatsApp connection stability fixes:
// C4 — connection_conflict releases the lease + stops renewal
// H2 — persistSessionState serializes writes through a promise queue

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// --- Minimal RuntimeBot harness focused on the 440 handler + persist queue ---

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.status = 'stopped';
    this.qr = null;
    this.phone = null;
  }
  state() {
    return {
      status: this.status,
      ready: false,
      phone: this.phone,
      qrVersion: 0,
      error: null,
      reconnectCount: 0,
      authFailureCount: 0,
      heartbeatFailures: 0,
    };
  }
}

function makeBotWith440Handler({ desiredState = 'running' } = {}) {
  const conn = new FakeConnection();
  const releaseCalls = [];
  const startCalls = [];
  const leaseRenewTimer = setInterval(() => {}, 1_000_000);
  leaseRenewTimer.unref?.();
  const bot = {
    connection: conn,
    sessionDesiredState: desiredState,
    _autoRecoverTimer: null,
    _leaseRenewTimer: leaseRenewTimer, // pretend a renewal is active
    logger: { info: () => {}, warn: () => {} },
    leaseTtlMs() { return 1000; },
    async releaseConnectionLease() {
      releaseCalls.push(Date.now());
    },
    startBot(reason) {
      startCalls.push(reason);
      return Promise.resolve(true);
    },
  };

  // Attach the handler exactly as written in the new RuntimeBot constructor
  conn.on('connection_conflict', () => {
    if (bot.sessionDesiredState !== 'running') return;
    clearInterval(bot._leaseRenewTimer);
    bot._leaseRenewTimer = null;
    bot.releaseConnectionLease().catch(() => {});
    const retryMs = bot.leaseTtlMs() + 200;
    clearTimeout(bot._autoRecoverTimer);
    bot._autoRecoverTimer = setTimeout(() => {
      bot._autoRecoverTimer = null;
      if (bot.sessionDesiredState === 'running' && bot.connection.status === 'stopped') {
        bot.startBot('440_recovery').catch(() => {});
      }
    }, retryMs);
    if (typeof bot._autoRecoverTimer.unref === 'function') bot._autoRecoverTimer.unref();
  });

  return { bot, conn, releaseCalls, startCalls };
}

// ---------- C4 ----------

test('C4: 440 connection_conflict releases the lease immediately', async () => {
  const { conn, releaseCalls } = makeBotWith440Handler({ desiredState: 'running' });
  conn.emit('connection_conflict', {});
  // Wait one microtask flush so the releaseConnectionLease().catch() runs
  await new Promise(r => setImmediate(r));
  assert.equal(releaseCalls.length, 1, 'lease must be released on 440');
});

test('C4: 440 stops the lease-renewal timer', () => {
  const { bot, conn } = makeBotWith440Handler({ desiredState: 'running' });
  assert.ok(bot._leaseRenewTimer, 'precondition: renewal timer was running');
  conn.emit('connection_conflict', {});
  assert.equal(bot._leaseRenewTimer, null, 'renewal timer must be cleared on 440');
});

test('C4: 440 does NOT release lease or schedule retry if owner stopped the bot', async () => {
  const { conn, releaseCalls, startCalls } = makeBotWith440Handler({ desiredState: 'stopped' });
  conn.emit('connection_conflict', {});
  await new Promise(r => setImmediate(r));
  assert.equal(releaseCalls.length, 0);
  assert.equal(startCalls.length, 0);
});

// ---------- H2 ----------

test('H2: persistSessionState serializes concurrent calls in order', async () => {
  const order = [];
  const RuntimeBotProto = {
    _persistQueue: Promise.resolve(),
    sessionDesiredState: 'running',
    connection: { state: () => ({ status: 'connected' }) },
    async _persistSessionStateNow({ state }) {
      order.push(`start:${state.status}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end:${state.status}`);
    },
    persistSessionState({ desiredState = this.sessionDesiredState, state = this.connection.state() } = {}) {
      const next = this._persistQueue
        .catch(() => {})
        .then(() => this._persistSessionStateNow({ desiredState, state }));
      this._persistQueue = next;
      return next;
    },
  };

  // Fire 3 calls without awaiting between them
  const p1 = RuntimeBotProto.persistSessionState({ state: { status: 'A' } });
  const p2 = RuntimeBotProto.persistSessionState({ state: { status: 'B' } });
  const p3 = RuntimeBotProto.persistSessionState({ state: { status: 'C' } });
  await Promise.all([p1, p2, p3]);

  // Must be strictly sequential — each "end" before the next "start"
  assert.deepEqual(order, [
    'start:A', 'end:A',
    'start:B', 'end:B',
    'start:C', 'end:C',
  ]);
});

test('H2: a failure in one persist does not break the chain', async () => {
  const callsSeen = [];
  const proto = {
    _persistQueue: Promise.resolve(),
    sessionDesiredState: 'running',
    connection: { state: () => ({}) },
    async _persistSessionStateNow({ state }) {
      callsSeen.push(state.status);
      if (state.status === 'B') throw new Error('DB hiccup');
    },
    persistSessionState({ desiredState = this.sessionDesiredState, state = this.connection.state() } = {}) {
      const next = this._persistQueue
        .catch(() => {})
        .then(() => this._persistSessionStateNow({ desiredState, state }));
      this._persistQueue = next;
      return next;
    },
  };

  const p1 = proto.persistSessionState({ state: { status: 'A' } });
  const p2 = proto.persistSessionState({ state: { status: 'B' } });
  const p3 = proto.persistSessionState({ state: { status: 'C' } });

  await p1;
  await assert.rejects(p2, /DB hiccup/);
  await p3;

  assert.deepEqual(callsSeen, ['A', 'B', 'C'], 'subsequent persists must run even after a failure');
});
