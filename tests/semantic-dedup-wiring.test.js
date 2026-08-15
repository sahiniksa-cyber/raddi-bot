'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSemanticDuplicate } = require('../src/services/ai/conversation-state');
const { loadRecentAssistantReplies } = require('../src/workers/ai-worker');

// Pure decision the worker uses when SEMANTIC_DEDUP_ENABLED is on.
test('SEMANTIC_DEDUP: identical intent with no new customer turn is a duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'promise_followup',
    recentReplyIntents: ['ask_email', 'promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});

test('SEMANTIC_DEDUP: different intent is not a duplicate', () => {
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'give_price',
    recentReplyIntents: ['promise_followup'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), false);
});

test('loadRecentAssistantReplies is tenant-scoped and returns content+intent', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ content: 'طلبك قيد المتابعة', intent: 'promise_followup' }], rowCount: 1 };
    },
  };
  const rows = await loadRecentAssistantReplies({ database, userId: 'u1', conversationId: 'c1', limit: 6 });
  assert.deepEqual(rows, [{ content: 'طلبك قيد المتابعة', intent: 'promise_followup' }]);
  const q = calls[0];
  assert.ok(/user_id = \$1/.test(q.sql) && /conversation_id = \$2/.test(q.sql));
  assert.ok(/raw_payload->>'replyIntent'/.test(q.sql));
  assert.deepEqual(q.params, ['u1', 'c1', 6]);
});

test('loadRecentAssistantReplies is fail-open on DB error → []', async () => {
  const database = { isConfigured: () => true, async query() { throw new Error('boom'); } };
  const rows = await loadRecentAssistantReplies({ database, userId: 'u1', conversationId: 'c1' });
  assert.deepEqual(rows, []);
});
