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
