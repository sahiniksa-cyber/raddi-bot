'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEscalationJobKey,
  normalizeOutgoingJobKey,
} = require('../src/queues/outgoing-job-key');

// ── Fix 1: normalizeOutgoingJobKey must strip ":" from ALL return paths ──────

test('normalizeOutgoingJobKey: raw jobKey with ":" is sanitised (fallback path)', () => {
  const key = normalizeOutgoingJobKey('ai-worker:123:abc', {});
  assert.equal(/:/.test(key), false, `expected no ":" but got: ${key}`);
  assert.equal(key, 'ai-worker-123-abc');
});

test('normalizeOutgoingJobKey: clean replyMessageId UUID is returned unchanged', () => {
  const key = normalizeOutgoingJobKey('x', { replyMessageId: 'uuid-1234' });
  assert.equal(key, 'uuid-1234');
});

test('normalizeOutgoingJobKey: replyMessageId with ":" is sanitised', () => {
  const key = normalizeOutgoingJobKey('a:b', { replyMessageId: 'a:b' });
  assert.equal(/:/.test(key), false, `expected no ":" but got: ${key}`);
  assert.equal(key, 'a-b');
});

test('normalizeOutgoingJobKey: escalation path produces key free of ":" ending with -escalation', () => {
  const key = normalizeOutgoingJobKey('rid', { escalation: true, replyMessageId: 'rid' });
  assert.equal(/:/.test(key), false, `expected no ":" but got: ${key}`);
  assert.match(key, /escalation/);
});

test('normalizeOutgoingJobKey: old ":escalation" suffix in jobKey is migrated safely', () => {
  const key = normalizeOutgoingJobKey('8c7e8254-994e-4a04-8d18-6d488ed13041:escalation', { escalation: true });
  assert.equal(key, '8c7e8254-994e-4a04-8d18-6d488ed13041-escalation');
  assert.equal(/:/.test(key), false);
});

test('normalizeOutgoingJobKey: escalation key built from replyMessageId has no ":"', () => {
  // replyMessageId itself contains ":" (theoretical edge case from legacy data)
  const key = normalizeOutgoingJobKey('fallback', { escalation: true, replyMessageId: 'ai-worker:job:uuid' });
  assert.equal(/:/.test(key), false, `expected no ":" but got: ${key}`);
  assert.match(key, /escalation/);
});

// ── buildEscalationJobKey (existing behaviour preserved) ─────────────────────

test('buildEscalationJobKey avoids Redis separator characters', () => {
  const key = buildEscalationJobKey('8c7e8254-994e-4a04-8d18-6d488ed13041');
  assert.equal(key, '8c7e8254-994e-4a04-8d18-6d488ed13041-escalation');
  assert.doesNotMatch(key, /:/);
});

test('buildEscalationJobKey sanitises colons in input', () => {
  const key = buildEscalationJobKey('some:key:value');
  assert.equal(/:/.test(key), false, `expected no ":" but got: ${key}`);
  assert.match(key, /-escalation$/);
});

// ── Non-escalation paths remain correct ──────────────────────────────────────

test('normalizeOutgoingJobKey: non-escalation clean key is unchanged', () => {
  assert.equal(normalizeOutgoingJobKey('reply-1', { escalation: false }), 'reply-1');
});

test('normalizeOutgoingJobKey: no payload falls back to sanitised jobKey', () => {
  const key = normalizeOutgoingJobKey('some:legacy:key');
  assert.equal(/:/.test(key), false);
  assert.equal(key, 'some-legacy-key');
});
