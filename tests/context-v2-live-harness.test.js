'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../scripts/context-engine-v2-live');

// Verifies the LIVE harness is COMPLETE (structure only — no provider calls here).
// The live RUN itself is BLOCKED without a staging key; this proves the scenarios
// and instrumentation exist so the PASS claims about completeness are test-backed.

test('A–H reference scenarios are all present (plus the payment scenario)', () => {
  const ids = harness.scenarios.map((s) => s.id);
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    assert.ok(ids.some((id) => id.startsWith(`${letter}:`)), `scenario ${letter} missing`);
  }
  assert.ok(ids.some((id) => id.startsWith('PAYMENT')), 'payment scenario missing');
});

test('each scenario has a real turn list and at least one asserted expectation', () => {
  for (const sc of harness.scenarios) {
    const turns = sc.build ? sc.build() : sc.turns;
    assert.ok(Array.isArray(turns) && turns.length >= 2, `${sc.id}: too few turns`);
    assert.ok(turns.some((t) => t.expect), `${sc.id}: no expectations asserted`);
  }
});

test('the 50-turn extraction-stability scenario really has 50 customer turns', () => {
  const fifty = harness.buildFiftyTurnScenario();
  assert.ok(fifty.stability === true);
  assert.equal(fifty.turns.length, 50);
  assert.ok(fifty.turns.every((t) => typeof t.c === 'string' && t.c.trim()));
});

test('token metrics are implemented (usage extraction + percentiles)', () => {
  assert.equal(harness.outputTokensOf({ completion_tokens: 123 }), 123);
  assert.equal(harness.outputTokensOf({ output_tokens: 77 }), 77);
  assert.equal(harness.outputTokensOf(null), null);
  const stats = harness.tokenStats([10, 20, 30, 40, 100]);
  assert.equal(stats.count, 5);
  assert.equal(stats.max, 100);
  assert.ok(stats.p50 >= 20 && stats.p50 <= 40);
  assert.ok(stats.p95 >= 40);
});

test('extractWithUsage exists and returns usage from a stubbed provider (no core change)', async () => {
  const stubAi = {
    raw: async () => ({
      usage: { completion_tokens: 250 },
      choices: [{ message: { content: JSON.stringify({ active_topic: 'x', salient_memories: [{ summary: 'جديد', source: 'customer' }] }) } }],
    }),
  };
  const out = await harness.extractWithUsage(stubAi, {
    previousState: { salient_memories: [{ summary: 'قديم', source: 'customer', last_updated: '1' }] },
    newTurns: [{ role: 'user', content: 'مرحبا' }],
  });
  assert.equal(out.extraction_ok, true);
  assert.equal(out.usage.completion_tokens, 250);
  // preserves the older memory (mergePreservedMemories) — faithful to the service
  assert.ok(out.state.salient_memories.some((m) => m.summary === 'قديم'));
  assert.ok(out.state.salient_memories.some((m) => m.summary === 'جديد'));
});
