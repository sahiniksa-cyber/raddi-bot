'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSemanticDuplicate, buildStaleClaimQuery } = require('../src/services/ai/conversation-state');

test('semantic dup: same intent, no new customer turn between → duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});

test('semantic dup: same intent but a new customer turn arrived → NOT duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: true,
  }), false);
});

test('semantic dup: different intent → NOT duplicate; missing intent → NOT duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'give_price', recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), false);
  assert.equal(isSemanticDuplicate({
    candidateIntent: '', recentReplyIntents: ['x'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), false);
});

test('buildStaleClaimQuery scopes by user_id and excludes folded inbound ids', () => {
  const { sql, params } = buildStaleClaimQuery({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1',
    generatedAgainstTs: '2026-08-13T10:00:00.000Z', foldedInboundIds: ['a', 'b'],
  });
  assert.ok(/UPDATE messages/.test(sql));
  assert.ok(/SET status = 'sending'/.test(sql));
  assert.ok(/status IN \('queued_for_send', 'sending'\)/.test(sql));
  assert.ok(/user_id = \$2/.test(sql));            // explicit tenant scope
  assert.ok(/NOT EXISTS/.test(sql));
  assert.ok(/direction = 'inbound'/.test(sql));
  assert.ok(/created_at > \$4/.test(sql));
  assert.ok(/<> ALL\(\$5/.test(sql));
  assert.deepEqual(params, ['r1', 'u1', 'c1', '2026-08-13T10:00:00.000Z', ['a', 'b']]);
});
