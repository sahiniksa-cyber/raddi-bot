'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// NOTE: these constants are read at require time. node --test runs each file
// in its own process, so no other test can have mutated the env first.
const { CONCURRENCY, LOCK_DURATION_MS } = require('../src/workers/ai-worker');

test('AI worker defaults: 4 concurrent conversations', () => {
  assert.equal(CONCURRENCY, 4);
});

test('AI worker lock outlives the worst-case AI retry chain (~150s)', () => {
  assert.equal(LOCK_DURATION_MS, 180000);
  assert.ok(LOCK_DURATION_MS > 150000, 'lock must be longer than 30s timeout × 3 attempts + backoff');
});
