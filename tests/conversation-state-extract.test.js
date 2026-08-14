'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');

const okClient = {
  raw: async () => ({ choices: [{ message: { content: '{"active_topic":"shipping","open_issues":[],"resolved_issues":[]}' } }] }),
};

test('extractConversationState returns validated state + extraction_ok=true, reconciled with system facts', async () => {
  const out = await extractConversationState({
    userId: 'u1', conversationId: 'c1',
    previousState: {}, newTurns: [{ role: 'user', content: 'وين طلبي' }], lastBotReply: '',
    config: {}, aiClient: okClient, systemFacts: { escalationPending: true },
  });
  assert.equal(out.extraction_ok, true);
  assert.equal(out.state.active_topic, 'shipping');
  assert.equal(out.state.system.escalationPending, true);
});

test('extractConversationState is fail-soft: client throws → extraction_ok=false, prior state preserved', async () => {
  const boomClient = { raw: async () => { throw new Error('timeout'); } };
  const out = await extractConversationState({
    userId: 'u1', conversationId: 'c1',
    previousState: { active_topic: 'prior' }, newTurns: [{ role: 'user', content: 'x' }], lastBotReply: '',
    config: {}, aiClient: boomClient, systemFacts: {},
  });
  assert.equal(out.extraction_ok, false);
  assert.equal(out.state.active_topic, 'prior'); // prior preserved, not presented as new truth by caller
});

test('extractConversationState is fail-soft on non-JSON model output', async () => {
  const junkClient = { raw: async () => ({ choices: [{ message: { content: 'sorry, cannot' } }] }) };
  const out = await extractConversationState({
    userId: 'u1', conversationId: 'c1',
    previousState: { active_topic: 'kept' }, newTurns: [{ role: 'user', content: 'x' }],
    config: {}, aiClient: junkClient, systemFacts: {},
  });
  assert.equal(out.extraction_ok, false);
  assert.equal(out.state.active_topic, 'kept');
});
