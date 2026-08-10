'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAiReplyQueueOptions,
  buildScopedQueueJobKey,
} = require('../src/queues/message-queue');

const base = {
  userId: 'tenant-1',
  tenantId: 'tenant-1',
  channelId: 'whatsapp',
  conversationId: 'conversation-1',
  customerId: 'customer-1',
  messageId: 'message-1',
};

test('AI debounce key is derived from tenant, channel, conversation, and customer', () => {
  const original = buildAiReplyQueueOptions(base, {});
  assert.match(original.jobKey, /^ai-/);

  for (const changed of [
    { tenantId: 'tenant-2', userId: 'tenant-2' },
    { channelId: 'instagram' },
    { conversationId: 'conversation-2' },
    { customerId: 'customer-2' },
  ]) {
    const candidate = buildAiReplyQueueOptions({ ...base, ...changed }, {});
    assert.notEqual(candidate.jobKey, original.jobKey);
  }
});

test('all scoped queue keys are stable and reject contradictory tenant aliases', () => {
  const first = buildScopedQueueJobKey('incoming', base, 'provider-1');
  const second = buildScopedQueueJobKey('incoming', { ...base }, 'provider-1');
  assert.equal(first, second);
  assert.doesNotMatch(first, /:/);

  assert.throws(
    () => buildScopedQueueJobKey(
      'incoming',
      { ...base, tenantId: 'tenant-other' },
      'provider-1',
    ),
    /tenant alias mismatch/,
  );
});
