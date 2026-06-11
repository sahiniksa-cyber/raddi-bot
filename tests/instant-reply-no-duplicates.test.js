'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectInstantReplies } = require('../src/services/bot/platform-features');
const { messagesCoveredByTriggers } = require('../src/workers/ai-worker');

// Production case 2026-06-11 (conversation d8618a0a): overlapping greeting
// keywords produced "وعليكم السلام يـ هلا ومرحبا يـ هلا ومرحبا" — the canned
// reply duplicated inside ONE message.

test('overlapping keywords fire only the most specific one (no duplicated greeting)', () => {
  const config = {
    autoReplyKeywords: {
      'السلام عليكم': 'وعليكم السلام يـ هلا ومرحبا',
      'سلام': 'يـ هلا ومرحبا',
    },
  };
  const { matched } = collectInstantReplies(config, 'السلام عليكم');
  assert.equal(matched.length, 1, `expected one match, got: ${matched.map(m => m.keyword).join(', ')}`);
  assert.equal(matched[0].keyword, 'السلام عليكم', 'longest (most specific) keyword wins');
});

test('two different keywords with the SAME reply text produce that reply once', () => {
  const config = {
    autoReplyKeywords: {
      'هلا': 'يـ هلا ومرحبا',
      'مرحبا': 'يـ هلا ومرحبا',
    },
  };
  const { matched } = collectInstantReplies(config, 'هلا ومرحبا فيكم');
  const replies = matched.map(m => m.reply);
  assert.equal(new Set(replies).size, replies.length, 'no duplicate reply texts');
  assert.equal(replies.filter(r => r === 'يـ هلا ومرحبا').length, 1);
});

test('genuinely distinct keywords still both match', () => {
  const config = {
    autoReplyKeywords: {
      'السلام عليكم': 'وعليكم السلام',
      'الدوام': 'دوامنا من 9 إلى 9',
    },
  };
  const { matched, hasExtraQuestion } = collectInstantReplies(config, 'السلام عليكم متى الدوام عندكم؟');
  assert.equal(matched.length, 2);
  assert.equal(hasExtraQuestion, true);
});

// Production case: AI call failed in combine mode → fallback sent the greeting
// only and marked ALL FOUR messages answered_by_ai — the customer's real
// questions ("معلق الموقع", "ضروري احتاجه الان") were buried with no reply,
// no escalation, no retry.

test('messagesCoveredByTriggers returns only the messages the canned replies actually answer', () => {
  const matched = [{ keyword: 'السلام عليكم', reply: 'وعليكم السلام' }];
  const messages = [
    { id: 'm1', content: 'السلام عليكم' },
    { id: 'm2', content: '[صورة من العميل]' },
    { id: 'm3', content: 'معلق الموقع' },
    { id: 'm4', content: 'ضروري احتاجه الان' },
  ];
  const covered = messagesCoveredByTriggers(messages, matched);
  assert.deepEqual(covered.map(m => m.id), ['m1'], 'only the greeting message is answered by the canned greeting');
});

test('messagesCoveredByTriggers keeps everything when there are no matches (defensive)', () => {
  const messages = [{ id: 'm1', content: 'نص' }];
  assert.deepEqual(messagesCoveredByTriggers(messages, []), []);
});
