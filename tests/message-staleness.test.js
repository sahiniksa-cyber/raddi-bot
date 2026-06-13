'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  staleMaxAgeMs,
  staleCutoffMs,
  toMillis,
  isOriginalMessageStale,
} = require('../lib/message-staleness');

const NOW = 1_700_000_000_000; // realistic 2023+ ms reference (above the s/ms boundary)
const MIN = 60 * 1000;

test('cutoff SLIDES with now — never frozen', () => {
  // 30 min default → cutoff is exactly 30 min before the supplied now.
  assert.equal(staleCutoffMs(NOW), NOW - 30 * MIN);
  assert.equal(staleCutoffMs(NOW + 60 * MIN), NOW + 60 * MIN - 30 * MIN);
});

test('default policy is 30 minutes, env-overridable', () => {
  const prev = process.env.WA_ACCEPT_MESSAGES_GRACE_MS;
  delete process.env.WA_ACCEPT_MESSAGES_GRACE_MS;
  try {
    assert.equal(staleMaxAgeMs(), 30 * MIN);
    process.env.WA_ACCEPT_MESSAGES_GRACE_MS = '600000';
    assert.equal(staleMaxAgeMs(), 600000);
    process.env.WA_ACCEPT_MESSAGES_GRACE_MS = 'garbage';
    assert.equal(staleMaxAgeMs(), 30 * MIN, 'invalid env falls back to default');
  } finally {
    if (prev === undefined) delete process.env.WA_ACCEPT_MESSAGES_GRACE_MS;
    else process.env.WA_ACCEPT_MESSAGES_GRACE_MS = prev;
  }
});

test('toMillis treats seconds and ms correctly', () => {
  assert.equal(toMillis(1_700_000_000), 1_700_000_000_000, 'seconds → ms');
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000, 'ms stays ms');
  assert.equal(toMillis(0), null);
  assert.equal(toMillis('abc'), null);
  assert.equal(toMillis(null), null);
});

test('THE RULE: a 2-hour-old message is stale; a 5-min-old one is fresh', () => {
  assert.equal(isOriginalMessageStale((NOW - 120 * MIN) / 1000, NOW), true, '2h old (seconds) → stale');
  assert.equal(isOriginalMessageStale(NOW - 120 * MIN, NOW), true, '2h old (ms) → stale');
  assert.equal(isOriginalMessageStale(NOW - 5 * MIN, NOW), false, '5m old → fresh');
  assert.equal(isOriginalMessageStale(NOW - 31 * MIN, NOW), true, 'just over 30m → stale');
  assert.equal(isOriginalMessageStale(NOW - 29 * MIN, NOW), false, 'just under 30m → fresh');
});

test('fail-open: a missing/invalid timestamp is NOT treated as stale', () => {
  assert.equal(isOriginalMessageStale(null, NOW), false);
  assert.equal(isOriginalMessageStale(undefined, NOW), false);
  assert.equal(isOriginalMessageStale(0, NOW), false);
});

// Wiring: both independent layers must consult this single module.
test('layer 1 (ingest manager) uses the shared sliding policy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'), 'utf8');
  assert.match(src, /message-staleness/, 'manager must import the shared policy');
  assert.match(src, /isOriginalMessageStale|staleCutoffMs/, 'manager must use the sliding cutoff, not a frozen field');
});

test('layer 2 (ai-worker) re-validates the original timestamp before replying', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  assert.match(src, /message-staleness/, 'worker must import the shared policy');
  assert.match(src, /isOriginalMessageStale/, 'worker must re-check the original timestamp');
});
