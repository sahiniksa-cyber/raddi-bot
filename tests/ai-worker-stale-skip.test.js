'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Source-structure assertions: the staleness guard must sit BEFORE any reply
// generation/quota spend, and skip (not answer) when all pending messages are
// older than the policy. (Full behavioral coverage of the policy math lives in
// message-staleness.test.js; the live end-to-end proof runs against production
// after deploy.)

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');

test('the stale guard runs before the quota check and the AI call', () => {
  const guardIdx = src.indexOf('isOriginalMessageStale(m?.raw_payload?.timestamp)');
  const quotaIdx = src.indexOf('await checkMessageQuota(userId)');
  const aiCallIdx = src.indexOf('await ai.getReply(');
  assert.ok(guardIdx > -1, 'stale guard must exist');
  assert.ok(guardIdx < quotaIdx, 'stale guard must run before quota is consumed');
  assert.ok(guardIdx < aiCallIdx, 'stale guard must run before the AI is called');
});

test('the stale guard retires messages as ai_failed and returns skipped', () => {
  const block = src.slice(src.indexOf('LAYER 2 of the staleness guard'), src.indexOf('const mediaAnalyzer'));
  assert.match(block, /status = 'ai_failed'/, 'stale messages are retired (terminal), not left queued');
  assert.match(block, /reason: 'stale_message'/);
  assert.match(block, /skipped: true, reason: 'stale_message'/, 'job ends as a skip — no reply');
  assert.ok(!/sendInstantAutoReply|enqueueOutgoingWhatsapp/.test(block), 'the guard must NOT send anything');
});

test('the guard is fail-open: only ALL-stale batches are skipped', () => {
  assert.match(src, /pendingMessages\.every\(m => isOriginalMessageStale/, 'every() — a single fresh message keeps the batch alive');
});
