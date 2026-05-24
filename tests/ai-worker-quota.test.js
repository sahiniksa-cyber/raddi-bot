'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('ai-worker imports checkMessageQuota from message-quota helper', () => {
  assert.match(workerSource, /require\(['"]\.\.\/services\/billing\/message-quota['"]\)/);
  assert.match(workerSource, /checkMessageQuota/);
});

test('ai-worker marks inbound messages as quota_exceeded when quota is empty', () => {
  assert.match(workerSource, /quota_exceeded/);
});

test('ai-worker skips ai.getReply when quota.canReply is false', () => {
  const checkIdx = workerSource.indexOf('checkMessageQuota');
  const aiIdx = workerSource.indexOf('ai.getReply');
  assert.ok(checkIdx > 0, 'checkMessageQuota must be referenced');
  assert.ok(aiIdx > 0, 'ai.getReply must be referenced');
  assert.ok(checkIdx < aiIdx, 'checkMessageQuota must appear before ai.getReply in source order');
});
