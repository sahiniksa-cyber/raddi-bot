'use strict';

// Behavioral tests for the per-key circuit breaker (tenant isolation primitive).
// Deterministic via an injected clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCircuitBreaker } = require('../src/services/reliability/circuit-breaker');

function clock(start = 0) {
  const t = { v: start };
  return { now: () => t.v, advance: (ms) => { t.v += ms; } };
}

test('opens after the failure threshold and blocks further calls', () => {
  const c = clock();
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: c.now });
  assert.equal(cb.canProceed('tenantA'), true);
  cb.onFailure('tenantA'); cb.onFailure('tenantA'); cb.onFailure('tenantA'); // 3 → open
  assert.equal(cb.stateOf('tenantA'), 'open');
  assert.equal(cb.canProceed('tenantA'), false, 'open circuit blocks the tenant');
});

test('isolation: one tenant opening does NOT affect another tenant', () => {
  const c = clock();
  const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
  cb.onFailure('noisy'); cb.onFailure('noisy'); // open
  assert.equal(cb.canProceed('noisy'), false);
  assert.equal(cb.canProceed('quiet'), true, 'other tenants stay unaffected');
});

test('after cooldown it half-opens (one trial), and a success closes it', () => {
  const c = clock();
  const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
  cb.onFailure('t'); cb.onFailure('t'); // open
  assert.equal(cb.canProceed('t'), false);
  c.advance(1000);
  assert.equal(cb.canProceed('t'), true, 'cooldown elapsed → half-open trial allowed');
  assert.equal(cb.stateOf('t'), 'half-open');
  cb.onSuccess('t');
  assert.equal(cb.stateOf('t'), 'closed');
  assert.equal(cb.canProceed('t'), true);
});

test('a failure during half-open re-opens the circuit', () => {
  const c = clock();
  const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });
  cb.onFailure('t'); // open
  c.advance(1000);
  cb.canProceed('t'); // → half-open
  cb.onFailure('t'); // re-open
  assert.equal(cb.stateOf('t'), 'open');
  assert.equal(cb.canProceed('t'), false);
});

test('a success resets the failure count (flaps do not accumulate to open)', () => {
  const c = clock();
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: c.now });
  cb.onFailure('t'); cb.onFailure('t'); // 2
  cb.onSuccess('t');                    // reset
  cb.onFailure('t'); cb.onFailure('t'); // 2 again, still closed
  assert.equal(cb.stateOf('t'), 'closed');
});
