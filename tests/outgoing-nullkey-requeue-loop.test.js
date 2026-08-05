'use strict';

// Regression: keyless CONTROL sends (e.g. prompt-edit systemNotice messages to
// the escalation group) used to persist a jobs row with job_key = NULL. The
// worker marks jobs 'completed' by job_key, so a null-key row could NEVER reach
// a terminal state → the Phase-4 requeue loop re-sent the same message every
// ~60s forever. That was the real "still repeating" the merchant kept seeing —
// the send pipeline, not the edit handler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ensureNonEmptyOutgoingJobKey, normalizeOutgoingJobKey } = require('../src/queues/outgoing-job-key');

test('ensureNonEmptyOutgoingJobKey: keyless payload gets a stable non-null key', () => {
  // Prompt-edit systemNotice payload has no replyMessageId/messageId/jobKey.
  const norm = normalizeOutgoingJobKey(undefined, { systemNotice: true, sender: '120@g.us' });
  assert.equal(norm, '', 'normalize yields empty for a keyless control send');
  const key = ensureNonEmptyOutgoingJobKey(norm);
  assert.ok(key && key.length > 0, 'a non-null key is produced');
  assert.match(key, /^sys-/, 'generated keys are namespaced sys-*');
});

test('ensureNonEmptyOutgoingJobKey: preserves a real key untouched', () => {
  assert.equal(ensureNonEmptyOutgoingJobKey('reply-42'), 'reply-42');
  assert.equal(ensureNonEmptyOutgoingJobKey('reply-7-escalation'), 'reply-7-escalation');
});

test('ensureNonEmptyOutgoingJobKey: two keyless sends get DISTINCT keys (both can complete)', () => {
  const a = ensureNonEmptyOutgoingJobKey('');
  const b = ensureNonEmptyOutgoingJobKey('');
  assert.notEqual(a, b);
});

test('enqueueOutgoingWhatsapp forces a non-null key before persisting', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'queues', 'message-queue.js'), 'utf8');
  // The enqueue path must wrap the normalized key so recordJob never stores NULL.
  assert.match(src, /ensureNonEmptyOutgoingJobKey\(\s*[\s\S]*normalizeOutgoingJobKey/);
});

test('requeue loop expires legacy NULL job_key rows so they cannot loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  assert.match(src, /job_key IS NULL/);
  assert.match(src, /status = 'expired'[\s\S]*job_key IS NULL|job_key IS NULL[\s\S]*status IN \('queued', 'processing'\)/);
});
