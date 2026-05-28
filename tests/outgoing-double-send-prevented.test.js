'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEscalationJobKey,
  normalizeOutgoingJobKey,
} = require('../src/queues/outgoing-job-key');

test('normalizeOutgoingJobKey anchors on replyMessageId for non-escalation', () => {
  // Two enqueues for the SAME replyMessageId must collapse to the same job key,
  // regardless of what caller-supplied jobKey was passed.
  const k1 = normalizeOutgoingJobKey('caller-key-a', { replyMessageId: 'reply-42' });
  const k2 = normalizeOutgoingJobKey('caller-key-b', { replyMessageId: 'reply-42' });
  assert.equal(k1, k2, 'same replyMessageId must produce identical job keys');
  assert.equal(k1, 'reply-42');
});

test('different replyMessageId values produce different keys', () => {
  const k1 = normalizeOutgoingJobKey(null, { replyMessageId: 'reply-1' });
  const k2 = normalizeOutgoingJobKey(null, { replyMessageId: 'reply-2' });
  assert.notEqual(k1, k2);
});

test('escalation payload always routes to escalation-suffixed key', () => {
  const k = normalizeOutgoingJobKey('reply-1', { escalation: true, replyMessageId: 'reply-1' });
  assert.equal(k, buildEscalationJobKey('reply-1'));
  assert.match(k, /-escalation$/);
});

test('escalation and normal reply with same replyMessageId get DISTINCT keys (so both can ship)', () => {
  const normal = normalizeOutgoingJobKey(null, { replyMessageId: 'reply-7' });
  const escalation = normalizeOutgoingJobKey(null, { escalation: true, replyMessageId: 'reply-7' });
  assert.notEqual(normal, escalation);
});

test('message-queue recordJob SQL guards against re-opening completed jobs', () => {
  // Static check of the SQL — the WHERE clause must protect terminal-success states
  // from being reset to "queued" on a duplicate enqueue.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'queues', 'message-queue.js'),
    'utf8',
  );
  assert.match(src, /WHERE jobs\.status NOT IN \('completed', 'sent_to_provider'\)/);
});
