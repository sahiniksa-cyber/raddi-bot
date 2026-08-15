'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConversationState, saveConversationState } = require('../src/services/ai/conversation-state.service');
const { EMPTY_STATE } = require('../src/services/ai/conversation-state');

function mockDb(rows) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT .*FROM conversation_states/is.test(sql)) return { rows: rows || [], rowCount: (rows || []).length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('loadConversationState scopes by user_id AND conversation_id, returns EMPTY_STATE when absent', async () => {
  const db = mockDb([]);
  const out = await loadConversationState({ userId: 'u1', conversationId: 'c1', database: db });
  assert.deepEqual(out.state, EMPTY_STATE);
  assert.equal(out.extraction_ok, false);
  const q = db.calls[0];
  assert.ok(/user_id = \$1/.test(q.sql) && /conversation_id = \$2/.test(q.sql));
  assert.deepEqual(q.params, ['u1', 'c1']);
});

test('saveConversationState bumps version on ok and stamps reflects_message_id', async () => {
  const db = mockDb([]);
  await saveConversationState({
    userId: 'u1', conversationId: 'c1', sender: 's1',
    state: { active_topic: 'x' }, extractionOk: true, reflectsMessageId: 'm9', database: db,
  });
  const q = db.calls[0];
  assert.ok(/INSERT INTO conversation_states/i.test(q.sql));
  assert.ok(/state_version = conversation_states\.state_version \+ 1/.test(q.sql));
  assert.ok(/ON CONFLICT \(user_id, conversation_id\)/.test(q.sql));
  assert.equal(q.params[0], 'u1');
});

test('saveConversationState with extractionOk=false does NOT write a new state (only flags)', async () => {
  const db = mockDb([]);
  await saveConversationState({
    userId: 'u1', conversationId: 'c1', sender: 's1',
    state: { active_topic: 'ignored' }, extractionOk: false, reflectsMessageId: null, database: db,
  });
  const q = db.calls[0];
  assert.ok(/UPDATE conversation_states|INSERT INTO conversation_states/i.test(q.sql));
  assert.ok(/extraction_ok = FALSE/.test(q.sql));
  assert.ok(!/state_version = conversation_states\.state_version \+ 1/.test(q.sql));
});
