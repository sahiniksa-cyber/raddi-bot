'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationStateBlock } = require('../src/services/ai/conversation-state');

const STATE = {
  open_issues: [{ id: 'i2', summary: 'الترخيص غير ظاهر', status: 'open' }],
  resolved_issues: [{ id: 'i1', summary: 'تشغيل البرنامج', resolved_by: 'customer_confirmed' }],
  known_facts: { payment_method: 'تحويل بنكي' },
  active_topic: 'الترخيص',
  active_entity: null,
  customer_goal: null,
  actions_attempted: [],
  last_reply_intent: null,
};

test('no block unless canInject is true (fail-soft)', () => {
  assert.equal(buildConversationStateBlock(STATE, { canInject: false }), '');
  assert.equal(buildConversationStateBlock(null, { canInject: true }), '');
});

test('block lists resolved (do-not-resuggest), open, and known facts', () => {
  const block = buildConversationStateBlock(STATE, { canInject: true });
  assert.ok(block.includes('تشغيل البرنامج'));
  assert.ok(/لا تقترح|تأكّد حلّها/.test(block));
  assert.ok(block.includes('الترخيص غير ظاهر'));
  assert.ok(block.includes('تحويل بنكي'));
});

test('empty state with canInject yields empty string (nothing to say)', () => {
  const empty = {
    open_issues: [], resolved_issues: [], known_facts: {},
    active_topic: null, active_entity: null, customer_goal: null,
    actions_attempted: [], last_reply_intent: null,
  };
  assert.equal(buildConversationStateBlock(empty, { canInject: true }), '');
});
