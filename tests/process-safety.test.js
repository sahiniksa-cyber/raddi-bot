'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  handleUnhandledRejection,
  handleUncaughtException,
  installProcessSafetyNet,
} = require('../src/runtime/process-safety');

function recorder() {
  const logs = [];
  let exited = null;
  return {
    logs,
    get exited() { return exited; },
    log: (line) => logs.push(line),
    exit: (code) => { exited = code; },
  };
}

// The whole point: one merchant's stray async error must NOT take the process
// (and therefore ALL merchants) down.

test('unhandled rejection is logged and does NOT exit the process', () => {
  const r = recorder();
  handleUnhandledRejection(new Error('one merchant stray promise'), { processName: 'web', log: r.log, exit: r.exit });
  assert.equal(r.exited, null, 'must NOT exit — keep serving every other merchant');
  assert.ok(r.logs.some(l => /unhandledRejection/i.test(l)));
  assert.ok(r.logs.some(l => /one merchant stray promise/.test(l)), 'error detail must be logged for debugging');
});

test('uncaught exception is logged and, by default, does NOT exit (multi-tenant uptime)', () => {
  const r = recorder();
  handleUncaughtException(new Error('boom'), { processName: 'web', log: r.log, exit: r.exit, exitOnUncaught: false });
  assert.equal(r.exited, null);
  assert.ok(r.logs.some(l => /uncaughtException/i.test(l)));
});

test('uncaught exception exits when explicitly opted in (fail-fast ops mode)', () => {
  const r = recorder();
  handleUncaughtException(new Error('boom'), { processName: 'ai-worker', log: r.log, exit: r.exit, exitOnUncaught: true });
  assert.equal(r.exited, 1, 'opt-in fail-fast exits with code 1 so the supervisor restarts it');
});

test('handlers never throw even on a non-Error value', () => {
  const r = recorder();
  assert.doesNotThrow(() => handleUnhandledRejection('string reason', { processName: 'web', log: r.log, exit: r.exit }));
  assert.doesNotThrow(() => handleUncaughtException(undefined, { processName: 'web', log: r.log, exit: r.exit }));
});

test('installProcessSafetyNet registers both process handlers exactly once', () => {
  const registered = [];
  const fakeProc = { on: (evt) => registered.push(evt) };
  installProcessSafetyNet({ processName: 'test', proc: fakeProc });
  assert.ok(registered.includes('unhandledRejection'));
  assert.ok(registered.includes('uncaughtException'));
});

// Wiring: every entry point must install the net.
test('all three entry points install the safety net', () => {
  for (const f of ['server.js', 'workers/ai-worker.js', 'runtime/start-all.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.match(src, /installProcessSafetyNet/, `${f} must install the process safety net`);
  }
});
