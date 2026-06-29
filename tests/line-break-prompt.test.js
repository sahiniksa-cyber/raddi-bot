'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlatformPromptBlock } = require('../src/services/bot/platform-features');

function block(replyStyle) {
  return buildPlatformPromptBlock({ replyStyle });
}

test('connected (default) keeps the connected-sentences instruction', () => {
  assert.match(block({ lineBreakMode: 'connected' }), /جُمل متصلة/);
});

test('sentence mode instructs one sentence per line', () => {
  const b = block({ lineBreakMode: 'sentence' });
  assert.match(b, /كل جملة في سطر/);
  assert.doesNotMatch(b, /جُمل متصلة/);
});

test('topic mode instructs a blank line between topics', () => {
  const b = block({ lineBreakMode: 'topic' });
  assert.match(b, /موضوع/);
  assert.match(b, /سطر فارغ|سطر فاصل/);
});

test('words mode instructs short consecutive lines', () => {
  const b = block({ lineBreakMode: 'words' });
  assert.match(b, /أسطر قصيرة/);
  assert.doesNotMatch(b, /جُمل متصلة/);
});

test('ai mode keeps the distribute-over-lines instruction', () => {
  assert.match(block({ lineBreakMode: 'ai' }), /وزّع ردك على عدة أسطر/);
});

test('legacy multilineFormat:true still maps to the distribute-over-lines instruction', () => {
  const b = block({ multilineFormat: true });
  assert.match(b, /وزّع ردك على عدة أسطر/);
  assert.doesNotMatch(b, /جُمل متصلة/);
});

test('every mode still forbids bullet/markdown formatting', () => {
  for (const mode of ['connected', 'sentence', 'topic', 'words', 'ai']) {
    assert.match(block({ lineBreakMode: mode }), /ممنوع التعداد النقطي/, `mode ${mode} must keep the no-bullets ban`);
  }
});
