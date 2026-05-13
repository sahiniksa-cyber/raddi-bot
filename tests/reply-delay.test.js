'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveReplyDelayMs } = require('../src/workers/reply-delay');

test('resolveReplyDelayMs uses the configured reply delay preset range', () => {
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '30s' }, () => 0), 22000);
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '1min' }, () => 0), 50000);
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '1.5min' }, () => 0), 75000);
});

test('resolveReplyDelayMs keeps delay inside the selected preset range', () => {
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '30s' }, () => 0.999), 40000);
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '1min' }, () => 0.999), 75000);
  assert.equal(resolveReplyDelayMs({ replyDelayPreset: '1.5min' }, () => 0.999), 105000);
});

