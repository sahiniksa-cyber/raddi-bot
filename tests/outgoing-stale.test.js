'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSkipStaleOutgoingPayload,
  outgoingStaleMaxAgeMs,
} = require('../src/workers/outgoing-whatsapp-worker');

test('customer replies expire when they are older than the stale limit', () => {
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: false }, 601000, 600000), true);
});

test('escalation notifications are capped at 60 minutes (dedup now prevents spam on restart)', () => {
  // Just under 60 minutes: still allowed
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: true }, 59 * 60 * 1000, 600000), false);
  // Just over 60 minutes: skipped
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: true }, 61 * 60 * 1000, 600000), true);
});

test('stale window defaults to 30 minutes and honors the env override', () => {
  const prev = process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
  delete process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
  try {
    assert.equal(outgoingStaleMaxAgeMs(), 30 * 60 * 1000);
    process.env.OUTGOING_STALE_JOB_MAX_AGE_MS = '600000';
    assert.equal(outgoingStaleMaxAgeMs(), 600000);
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_STALE_JOB_MAX_AGE_MS;
    else process.env.OUTGOING_STALE_JOB_MAX_AGE_MS = prev;
  }
});
