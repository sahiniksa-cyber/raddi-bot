'use strict';

// Phase 10: per-key circuit breaker — the isolation primitive so one failing
// tenant (or a failing AI provider) can't drag the whole platform down. Pure &
// deterministic (inject `now`) so it is fully unit-testable. Ready to wire
// around the AI-provider call per userId; wiring is deferred to a staging
// environment because it touches the AI hot path and needs load validation.
//
// States per key: closed → (failures ≥ threshold) → open → (after cooldown)
// half-open → success → closed | failure → open.

function createCircuitBreaker({
  failureThreshold = 5,
  cooldownMs = 30000,
  now = () => Date.now(),
} = {}) {
  const keys = new Map(); // key → { state, failures, openedAt }

  function entry(key) {
    let e = keys.get(key);
    if (!e) { e = { state: 'closed', failures: 0, openedAt: 0 }; keys.set(key, e); }
    return e;
  }

  // May this key proceed right now? Transitions open→half-open once cooldown elapses.
  function canProceed(key) {
    const e = entry(key);
    if (e.state === 'open') {
      if (now() - e.openedAt >= cooldownMs) { e.state = 'half-open'; return true; }
      return false;
    }
    return true; // closed or half-open (single trial)
  }

  function onSuccess(key) {
    const e = entry(key);
    e.failures = 0;
    e.state = 'closed';
    e.openedAt = 0;
  }

  function onFailure(key) {
    const e = entry(key);
    if (e.state === 'half-open') { e.state = 'open'; e.openedAt = now(); return; }
    e.failures += 1;
    if (e.failures >= failureThreshold) { e.state = 'open'; e.openedAt = now(); }
  }

  function stateOf(key) { return entry(key).state; }
  function reset(key) { keys.delete(key); }

  return { canProceed, onSuccess, onFailure, stateOf, reset };
}

module.exports = { createCircuitBreaker };
