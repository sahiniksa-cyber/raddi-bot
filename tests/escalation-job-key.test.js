'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEscalationJobKey,
  normalizeOutgoingJobKey,
} = require('../src/queues/outgoing-job-key');

test('buildEscalationJobKey avoids Redis separator characters', () => {
  const key = buildEscalationJobKey('8c7e8254-994e-4a04-8d18-6d488ed13041');

  assert.equal(key, '8c7e8254-994e-4a04-8d18-6d488ed13041-escalation');
  assert.doesNotMatch(key, /:/);
});

test('normalizeOutgoingJobKey migrates old escalation keys to the safe form', () => {
  assert.equal(
    normalizeOutgoingJobKey('8c7e8254-994e-4a04-8d18-6d488ed13041:escalation', { escalation: true }),
    '8c7e8254-994e-4a04-8d18-6d488ed13041-escalation',
  );
});

test('normalizeOutgoingJobKey leaves non-escalation keys untouched', () => {
  assert.equal(
    normalizeOutgoingJobKey('reply-1', { escalation: false }),
    'reply-1',
  );
});
