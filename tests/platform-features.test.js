'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findAutoReply } = require('../src/services/bot/platform-features');

test('findAutoReply matches configured instant replies before AI', () => {
  const reply = findAutoReply({
    autoReplyKeywords: {
      'سعر الشحن': 'الشحن مجاني للطلبات فوق 200 ريال',
      hello: 'Hi there',
    },
  }, 'لو سمحت كم سعر الشحن للرياض؟');

  assert.equal(reply, 'الشحن مجاني للطلبات فوق 200 ريال');
});

test('findAutoReply ignores empty keywords and replies', () => {
  assert.equal(findAutoReply({
    autoReplyKeywords: {
      '': 'رد',
      test: '',
    },
  }, 'test'), '');
});

const { collectInstantReplies } = require('../src/services/bot/platform-features');
const G = { autoReplyKeywords: { 'السلام عليكم': 'وعليكم السلام، حياك الله', 'الشحن': 'الشحن مجاني فوق 200' } };

test('collect: bare trigger → no extra question', () => {
  const r = collectInstantReplies(G, 'السلام عليكم');
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].reply, 'وعليكم السلام، حياك الله');
  assert.equal(r.hasExtraQuestion, false);
});
test('collect: trigger + real question → hasExtraQuestion true', () => {
  const r = collectInstantReplies(G, 'السلام عليكم كم سعر ادوبي؟');
  assert.equal(r.hasExtraQuestion, true);
});
test('collect: trigger + tiny remainder → no extra question', () => {
  assert.equal(collectInstantReplies(G, 'السلام عليكم كيفك').hasExtraQuestion, false);
});
test('collect: no match → empty', () => {
  const r = collectInstantReplies(G, 'كلام عادي بدون محفز');
  assert.equal(r.matched.length, 0);
  assert.equal(r.hasExtraQuestion, false);
});
test('collect: multiple triggers captured', () => {
  const r = collectInstantReplies(G, 'السلام عليكم وش اخبار الشحن');
  assert.ok(r.matched.length >= 2);
});

// I1 — short question detection
test('collect: greeting + short question with mark → extra question', () => {
  assert.equal(collectInstantReplies(G, 'السلام عليكم بكم؟').hasExtraQuestion, true);
});
test('collect: greeting + single question word → extra question', () => {
  assert.equal(collectInstantReplies(G, 'السلام عليكم وين فرعكم').hasExtraQuestion, true);
});
test('collect: greeting + chitchat (كيفك) → NOT extra question', () => {
  assert.equal(collectInstantReplies(G, 'السلام عليكم كيفك').hasExtraQuestion, false);
});
