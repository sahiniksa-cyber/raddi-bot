'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSimulation } = require('../scripts/simulate-safe-replies');

test('shadow simulation has no product, isolation, forbidden-word, or version failures', async () => {
  const summary = await runSimulation();
  assert.equal(summary.mode, 'shadow_no_send');
  assert.ok(summary.scenarios >= 40);
  assert.equal(summary.repliesSentToWhatsapp, 0);
  assert.ok(summary.blockedOriginalDrafts >= 5);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.exactAccuracy, 1);
});
