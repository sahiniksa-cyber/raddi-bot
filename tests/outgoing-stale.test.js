'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSkipStaleOutgoingPayload } = require('../src/workers/outgoing-whatsapp-worker');

test('customer replies expire when they are older than the stale limit', () => {
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: false }, 601000, 600000), true);
});

test('owner escalation notifications do not expire like normal customer replies', () => {
  assert.equal(shouldSkipStaleOutgoingPayload({ escalation: true }, 60 * 60 * 1000, 600000), false);
});
