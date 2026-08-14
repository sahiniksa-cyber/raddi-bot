'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScopedJobKey } = require('../src/queues/message-queue');

test('buildScopedJobKey prefixes a non-globally-unique key with the tenant', () => {
  // Two tenants receiving a WhatsApp message with the SAME provider key.id must
  // NOT collide in the shared jobs(queue_name, job_key) namespace or BullMQ jobId.
  const a = buildScopedJobKey('tenant-A', 'WA-KEY-123');
  const b = buildScopedJobKey('tenant-B', 'WA-KEY-123');
  assert.notEqual(a, b);
  assert.equal(a, 'tenant-A:WA-KEY-123');
  assert.equal(b, 'tenant-B:WA-KEY-123');
});

test('buildScopedJobKey is idempotent when the key already carries the tenant prefix', () => {
  assert.equal(buildScopedJobKey('tenant-A', 'tenant-A:WA-KEY-123'), 'tenant-A:WA-KEY-123');
});

test('buildScopedJobKey falls back to the raw key when tenant is missing', () => {
  assert.equal(buildScopedJobKey(null, 'WA-KEY-123'), 'WA-KEY-123');
  assert.equal(buildScopedJobKey(undefined, 'k'), 'k');
});

test('buildScopedJobKey returns null when there is no key at all', () => {
  assert.equal(buildScopedJobKey('tenant-A', null), null);
  assert.equal(buildScopedJobKey('tenant-A', undefined), null);
});
