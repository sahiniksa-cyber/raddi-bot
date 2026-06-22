'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlatformPromptBlock } = require('../src/services/bot/platform-features');

const MULTILINE_RE = /وزّع ردك على عدة أسطر/;
const CONNECTED_RE = /جُمل متصلة/;

test('multilineFormat=true injects the multi-line instruction and drops the connected-sentences default', () => {
  const block = buildPlatformPromptBlock({ replyStyle: { multilineFormat: true } });
  assert.match(block, MULTILINE_RE);
  assert.doesNotMatch(block, CONNECTED_RE);
});

test('multilineFormat=false keeps the connected-sentences default (no regression, opt-in)', () => {
  const block = buildPlatformPromptBlock({ replyStyle: { multilineFormat: false } });
  assert.match(block, CONNECTED_RE);
  assert.doesNotMatch(block, MULTILINE_RE);
});

test('multilineFormat absent behaves like false (default unchanged)', () => {
  const block = buildPlatformPromptBlock({ replyStyle: {} });
  assert.match(block, CONNECTED_RE);
  assert.doesNotMatch(block, MULTILINE_RE);
});

test('dashboard exposes the multilineFormat toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.ok(html.includes('multilineFormat'), 'dashboard/index.html should reference multilineFormat');
});
