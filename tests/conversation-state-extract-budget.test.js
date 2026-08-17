'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compactStateForExtraction, buildExtractionRequest, EXTRACTION_SYSTEM_PROMPT, validateState,
} = require('../src/services/ai/conversation-state');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');

// ══ Bug 6 — bounded extraction output (compaction + computed token ceiling) ══

test('compactStateForExtraction bounds memories & entities and keeps the relevant ones', () => {
  const mems = [];
  for (let i = 0; i < 40; i++) mems.push({ summary: `ذاكرة عامة رقم ${i}`, source: 'customer', confidence: 'low', last_updated: String(i) });
  mems.push({ summary: 'العميل يريد اشتراك سنوي', source: 'customer', confidence: 'high', last_updated: '99' });
  const state = validateState({
    salient_memories: mems,
    active_entities: Array.from({ length: 25 }, (_, i) => ({ type: 'product', ref: `p${i}`, label: `منتج ${i}`, last_seen: String(i) })),
  });
  const c = compactStateForExtraction(state, { latestText: 'الاشتراك السنوي', maxMemories: 12, maxEntities: 10 });
  assert.ok(c.salient_memories.length <= 12);
  assert.ok(c.active_entities.length <= 10);
  assert.ok(c.salient_memories.some((m) => m.summary.includes('اشتراك سنوي')), 'the relevant memory is kept');
});

test('buildExtractionRequest computes a bounded token ceiling (>=700, <=1200) that scales with state size', () => {
  const small = buildExtractionRequest({ previousState: {}, newTurns: [{ role: 'user', content: 'مرحبا' }] });
  assert.ok(small.max_tokens >= 700 && small.max_tokens <= 1200);

  const bigState = validateState({
    salient_memories: Array.from({ length: 18 }, (_, i) => ({ summary: `ذاكرة طويلة نسبيا رقم ${i} تفاصيل`, source: 'customer', confidence: 'high' })),
    active_entities: Array.from({ length: 12 }, (_, i) => ({ type: 'product', ref: `p${i}`, label: `منتج ${i}` })),
    open_issues: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, summary: `مشكلة ${i}`, status: 'open' })),
  });
  const big = buildExtractionRequest({ previousState: bigState, newTurns: [{ role: 'user', content: 'رسالة' }] });
  assert.ok(big.max_tokens >= small.max_tokens, 'a larger state gets a larger ceiling');
  assert.ok(big.max_tokens <= 1200, 'but never above the hard ceiling');
});

test('extraction prompt instructs the model to keep memories bounded', () => {
  assert.ok(/[0-9]+\s*(salient|memor|ذاكر)/i.test(EXTRACTION_SYSTEM_PROMPT) || /at most|بحد أقصى|لا تتجاوز|أهم/.test(EXTRACTION_SYSTEM_PROMPT),
    'prompt caps the number of memories');
});

test('extractConversationState preserves older memories dropped from the compacted prompt (no silent loss)', async () => {
  const priorMems = [];
  for (let i = 0; i < 40; i++) priorMems.push({ summary: `حقيقة قديمة رقم ${i}`, source: 'customer', confidence: 'high', last_updated: String(i) });
  const prior = validateState({ salient_memories: priorMems });

  // The model (seeing only a compacted prior) returns a small state.
  const modelState = { active_topic: 'جديد', salient_memories: [{ summary: 'ملاحظة جديدة من هذا الدور', source: 'customer', confidence: 'high' }] };
  const ai = { raw: async () => ({ choices: [{ message: { content: JSON.stringify(modelState) } }] }) };

  const out = await extractConversationState({
    userId: 'u', conversationId: 'c', previousState: prior,
    newTurns: [{ role: 'user', content: 'دور جديد' }], aiClient: ai,
  });
  assert.equal(out.extraction_ok, true);
  assert.ok(out.state.salient_memories.some((m) => m.summary === 'ملاحظة جديدة من هذا الدور'), 'new memory kept');
  assert.ok(out.state.salient_memories.some((m) => /حقيقة قديمة رقم/.test(m.summary)), 'older memories not silently lost');
  assert.ok(out.state.salient_memories.length <= 50, 'still capped');
});
