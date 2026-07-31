'use strict';

// Behavioral tests for Phase 4: the periodic outgoing-requeue loop. A spy runner
// + mock timers verify cadence, the in-flight (no-overlap) guard, env gating,
// and that a failing runner never throws out of the interval.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startOutgoingRequeueLoop } = require('../src/workers/outgoing-whatsapp-worker');

test('disabled via env → returns null, schedules nothing', () => {
  const prev = process.env.STABILITY_OUTGOING_REQUEUE_ENABLED;
  process.env.STABILITY_OUTGOING_REQUEUE_ENABLED = 'false';
  try {
    const timer = startOutgoingRequeueLoop({ runner: async () => {}, intervalMs: 1000 });
    assert.equal(timer, null);
  } finally {
    if (prev === undefined) delete process.env.STABILITY_OUTGOING_REQUEUE_ENABLED;
    else process.env.STABILITY_OUTGOING_REQUEUE_ENABLED = prev;
  }
});

test('enabled → runs the requeue runner on each interval tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const timer = startOutgoingRequeueLoop({ runner: async () => { calls += 1; }, intervalMs: 1000, logger: {} });
  assert.ok(timer, 'a timer is scheduled');
  // flush microtasks between ticks so the async run() clears its in-flight flag
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 2, 'runner invoked once per tick');
});

test('in-flight guard: a slow run is not overlapped by the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  startOutgoingRequeueLoop({ runner: async () => { calls += 1; await gate; }, intervalMs: 1000, logger: {} });

  t.mock.timers.tick(1000);          // starts run #1 (awaits gate)
  t.mock.timers.tick(1000);          // blocked by in-flight guard
  assert.equal(calls, 1, 'no overlap while the previous run is pending');

  release();
  await Promise.resolve(); await Promise.resolve(); // let the finally clear inFlight
  t.mock.timers.tick(1000);          // now free → runs again
  assert.equal(calls, 2);
});

test('a failing runner is swallowed (never throws out of the interval)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const timer = startOutgoingRequeueLoop({ runner: async () => { throw new Error('db down'); }, intervalMs: 1000, logger: { error() {} } });
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.ok(timer);
});
