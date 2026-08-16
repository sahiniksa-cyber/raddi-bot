'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');

// Bug 4 — a truncated extraction (finish_reason=length / cut JSON) retries ONCE
// with a higher bounded ceiling, then falls soft. No architecture change.

test('truncated first response (finish_reason=length) → retry once at a higher ceiling → success', async () => {
  const reqs = [];
  let call = 0;
  const ai = {
    raw: async (req) => {
      reqs.push(req);
      call += 1;
      if (call === 1) return { choices: [{ finish_reason: 'length', message: { content: '{"active_topic":"partial","salient_memories":[{"summ' } }] };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ active_topic: 'مكتمل' }) } }] };
    },
  };
  const out = await extractConversationState({ userId: 'u', conversationId: 'c', previousState: { active_topic: 'قديم' }, newTurns: [{ role: 'user', content: 'رسالة' }], aiClient: ai });
  assert.equal(out.extraction_ok, true);
  assert.equal(out.state.active_topic, 'مكتمل');
  assert.equal(reqs.length, 2, 'exactly one retry');
  assert.ok(reqs[1].max_tokens > reqs[0].max_tokens, 'retry uses a higher ceiling');
  assert.ok(reqs[1].max_tokens <= 1600, 'retry ceiling stays bounded');
});

test('retry also truncated → fail-soft (prior preserved, not injected as truth)', async () => {
  let call = 0;
  const ai = {
    raw: async () => {
      call += 1;
      return { choices: [{ finish_reason: 'length', message: { content: '{"active_topic":"cut' } }] };
    },
  };
  const out = await extractConversationState({ userId: 'u', conversationId: 'c', previousState: { active_topic: 'محفوظ' }, newTurns: [{ role: 'user', content: 'x' }], aiClient: ai });
  assert.equal(out.extraction_ok, false);
  assert.equal(out.state.active_topic, 'محفوظ');
  assert.equal(call, 2, 'retried exactly once then gave up');
});

test('a clean first response does NOT retry (no extra cost)', async () => {
  let call = 0;
  const ai = { raw: async () => { call += 1; return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ active_topic: 'ok' }) } }] }; } };
  const out = await extractConversationState({ userId: 'u', conversationId: 'c', previousState: {}, newTurns: [{ role: 'user', content: 'x' }], aiClient: ai });
  assert.equal(out.extraction_ok, true);
  assert.equal(call, 1, 'no retry on a valid first response');
});

test('a genuine non-JSON refusal (not truncation) does NOT retry', async () => {
  let call = 0;
  const ai = { raw: async () => { call += 1; return { choices: [{ finish_reason: 'stop', message: { content: 'عذراً لا أستطيع.' } }] }; } };
  const out = await extractConversationState({ userId: 'u', conversationId: 'c', previousState: { active_topic: 'seed' }, newTurns: [{ role: 'user', content: 'x' }], aiClient: ai });
  assert.equal(out.extraction_ok, false);
  assert.equal(call, 1, 'a complete non-JSON answer is fail-soft, not a truncation retry');
});
