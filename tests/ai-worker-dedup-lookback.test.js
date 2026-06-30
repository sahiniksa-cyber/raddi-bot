'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Source-level structural assertion — mirrors the idiom in
// tests/cx-escalation-leak-and-double-send.test.js.
// The production call to findDuplicateRecentReply must use lookback: 6 so that
// boilerplate repeated more than 3 turns back is still caught and suppressed.

const aiWorkerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('findDuplicateRecentReply is called with lookback: 6', () => {
  assert.match(
    aiWorkerSource,
    /findDuplicateRecentReply\(\s*\{[\s\S]*?lookback:\s*6[\s\S]*?\}\s*\)/,
    'The production call to findDuplicateRecentReply must use lookback: 6 (not 3) to catch boilerplate repeated beyond 3 turns',
  );
});

test('findDuplicateRecentReply keeps threshold: 0.85', () => {
  assert.match(
    aiWorkerSource,
    /findDuplicateRecentReply\(\s*\{[\s\S]*?threshold:\s*0\.85[\s\S]*?\}\s*\)/,
    'threshold must remain 0.85',
  );
});
