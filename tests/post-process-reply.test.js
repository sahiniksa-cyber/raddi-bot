'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAvoidedContent } = require('../lib/post-process-reply');

test('stripAvoidedContent removes wrapping quotes around full reply', () => {
  assert.equal(stripAvoidedContent('"أبشر، السعر 99 ريال"'), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent removes internal quote marks but keeps the text', () => {
  assert.equal(
    stripAvoidedContent('قال العميل "أبي خصم" فأجبته بأنه ممكن'),
    'قال العميل أبي خصم فأجبته بأنه ممكن'
  );
});

test('stripAvoidedContent removes configured avoidPhrases', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك أي استفسار أنا موجود'] } };
  const reply = 'أبشر، السعر 99 ريال. إذا عندك أي استفسار أنا موجود.';
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent matches avoidPhrases with Arabic letter variations (همزة/ألف)', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك استفسار'] } };
  const reply = 'أبشر. اذا عندك استفسار راسلني';
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent returns original when filter removes everything', () => {
  const config = { replyStyle: { avoidPhrases: ['السعر 99 ريال'] } };
  assert.equal(stripAvoidedContent('السعر 99 ريال', config), 'السعر 99 ريال');
});

test('stripAvoidedContent is no-op when config has no avoidPhrases', () => {
  assert.equal(stripAvoidedContent('أبشر، السعر 99 ريال', {}), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent handles null/empty inputs gracefully', () => {
  assert.equal(stripAvoidedContent(null), '');
  assert.equal(stripAvoidedContent(''), '');
  assert.equal(stripAvoidedContent(undefined), '');
});

test('stripAvoidedContent preserves WhatsApp marker like [تحويل:...]', () => {
  const reply = 'خلني أحوّلك للمختص [تحويل:محمد|مشكلة دفع]';
  assert.equal(stripAvoidedContent(reply), reply);
});

test('stripAvoidedContent does not strip apostrophes between digits (e.g. measurements)', () => {
  assert.equal(stripAvoidedContent("القياس 5'2"), "القياس 5'2");
});
