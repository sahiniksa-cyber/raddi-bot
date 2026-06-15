'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlatformPromptBlock } = require('../src/services/bot/platform-features');
const { DEFAULT_CONFIG } = require('../lib/constants');

test('a merchant who never set emojiLevel is instructed NOT to use emoji', () => {
  const block = buildPlatformPromptBlock({ replyStyle: {} });
  assert.ok(block.includes('بدون إيموجي'), 'expected the no-emoji instruction in the prompt');
  assert.ok(!block.includes('إيموجي معتدل'), 'must NOT instruct medium emoji by default');
});

test('DEFAULT_CONFIG.replyStyle.emojiLevel is "none"', () => {
  assert.equal(DEFAULT_CONFIG.replyStyle.emojiLevel, 'none');
});

test('a merchant who explicitly chose emojis still gets them (default change is non-destructive)', () => {
  const block = buildPlatformPromptBlock({ replyStyle: { emojiLevel: 'medium' } });
  assert.ok(block.includes('إيموجي معتدل'), 'explicit emoji choice must be honoured');
});
