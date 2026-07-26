'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const matrix = require('../fixtures/simulation-critical-matrix.json');
const { runSimulation } = require('../../scripts/simulate-stabilization');

test('deterministic critical simulation executes 10,000 asserted, offline sequences', async () => {
  const report = await runSimulation({
    seed: 20260726,
    sequences: 10000,
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.seed, 20260726);
  assert.equal(report.sequences, 10000);
  assert.equal(report.networkDependencies, 0);
  assert.equal(report.assertions, report.sequences);
  assert.equal(report.criticalCases, matrix.cases.length);
  for (const item of matrix.cases) assert.ok(report.coverage[item.id] > 0);
});
