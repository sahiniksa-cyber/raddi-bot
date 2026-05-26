'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSkipStaleOutgoingPayload } = require('../src/workers/outgoing-whatsapp-worker');

test('customer replies expire when they are older than the stale limit', () => {
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: false }, 601000, 600000), true);
});

test('escalation notifications are capped at 60 minutes (dedup now prevents spam on restart)', () => {
  // Just under 60 minutes: still allowed
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: true }, 59 * 60 * 1000, 600000), false);
  // Just over 60 minutes: skipped
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: true }, 61 * 60 * 1000, 600000), true);
});
