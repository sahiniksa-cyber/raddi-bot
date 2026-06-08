'use strict';

// PR1 — smart 440 (connectionReplaced) recovery backoff.
//
// The old handler used a fixed delay of leaseTtlMs()+5000 (~125s), so a single
// device switch caused a 2-minute outage. The new logic recovers fast on the
// first conflict and escalates only when conflicts repeat in a short window:
//   connloopRecoveryDelayMs(n) = min(BASE * 2^(n-1), CAP)
// isInConnConflictBackoff() reports whether we're inside the current backoff
// window so the outgoing worker won't force a reconnect and defeat it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

const delayOf = (n) => RuntimeBot.prototype.connloopRecoveryDelayMs.call({}, n);

test('connloopRecoveryDelayMs escalates by doubling from an 8s base', () => {
  assert.equal(delayOf(1), 8000, 'first conflict recovers fast (8s)');
  assert.equal(delayOf(2), 16000);
  assert.equal(delayOf(3), 32000);
  assert.equal(delayOf(4), 64000);
});

test('connloopRecoveryDelayMs is capped at 120s', () => {
  assert.equal(delayOf(5), 120000, 'caps instead of growing to 128s');
  assert.equal(delayOf(50), 120000, 'still capped for runaway conflict counts');
});

test('connloopRecoveryDelayMs treats missing/invalid counts as the first attempt', () => {
  assert.equal(delayOf(0), 8000);
  assert.equal(delayOf(undefined), 8000);
});

test('connloopRecoveryDelayMs honours WA_CONN_CONFLICT_* env overrides', () => {
  const saved = { base: process.env.WA_CONN_CONFLICT_BASE_MS, cap: process.env.WA_CONN_CONFLICT_MAX_MS };
  process.env.WA_CONN_CONFLICT_BASE_MS = '2000';
  process.env.WA_CONN_CONFLICT_MAX_MS = '5000';
  try {
    assert.equal(delayOf(1), 2000);
    assert.equal(delayOf(2), 4000);
    assert.equal(delayOf(3), 5000, 'respects the lowered cap');
  } finally {
    if (saved.base === undefined) delete process.env.WA_CONN_CONFLICT_BASE_MS; else process.env.WA_CONN_CONFLICT_BASE_MS = saved.base;
    if (saved.cap === undefined) delete process.env.WA_CONN_CONFLICT_MAX_MS; else process.env.WA_CONN_CONFLICT_MAX_MS = saved.cap;
  }
});

test('isInConnConflictBackoff reflects the recovery window', () => {
  assert.equal(
    RuntimeBot.prototype.isInConnConflictBackoff.call({ _connConflictRecoveryUntil: Date.now() + 10000 }),
    true,
    'inside the window → backing off',
  );
  assert.equal(
    RuntimeBot.prototype.isInConnConflictBackoff.call({ _connConflictRecoveryUntil: Date.now() - 1 }),
    false,
    'past the window → free to reconnect',
  );
  assert.equal(
    RuntimeBot.prototype.isInConnConflictBackoff.call({}),
    false,
    'no conflict ever → not backing off',
  );
});
