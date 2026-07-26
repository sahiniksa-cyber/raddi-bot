'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MUTANTS, runMutations } = require('../../scripts/run-critical-mutations');

test('every named critical guard mutation is killed by a deterministic production-module probe', async () => {
  const report = await runMutations();
  assert.equal(report.status, 'passed');
  assert.equal(report.total, MUTANTS.length);
  assert.equal(report.killed, MUTANTS.length);
  assert.deepEqual(report.survivors, []);
  assert.equal(report.mutationScore, 1);
});
