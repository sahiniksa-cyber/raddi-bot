'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateState, buildConversationStateBlock, EMPTY_STATE,
} = require('../src/services/ai/conversation-state');

// ══ Bug 3 — entity recency / dedupe / cap / active precedence ══════════════

test('3a: newest entity survives the cap even when it is the LAST of 25', () => {
  const entities = [];
  for (let i = 1; i <= 25; i++) entities.push({ type: 'product', ref: `p${i}`, label: `منتج ${i}`, last_seen: String(i) });
  const s = validateState({ active_entities: entities });
  const refs = s.active_entities.map((e) => e.ref);
  assert.ok(refs.includes('p25'), 'the latest entity (#25) must survive the cap');
  assert.ok(!refs.includes('p1'), 'the oldest (#1) is the one dropped, not the newest');
  assert.equal(s.active_entities.length, 20);
});

test('3b: #25 becomes the active entity', () => {
  const entities = [];
  for (let i = 1; i <= 25; i++) entities.push({ type: 'product', ref: `p${i}`, label: `منتج ${i}`, last_seen: String(i) });
  const s = validateState({ active_entities: entities });
  assert.equal(s.active_entity.ref, 'p25');
});

test('3c: duplicate type+ref is deduped, keeping the later/stronger, merging fields', () => {
  const s = validateState({
    active_entities: [
      { type: 'product', ref: 'a', label: 'A', status: null, confidence: 'low', last_seen: '2' },
      { type: 'product', ref: 'a', label: 'A محدّث', status: 'active', confidence: 'high', last_seen: '9' },
    ],
  });
  const a = s.active_entities.filter((e) => e.ref === 'a');
  assert.equal(a.length, 1, 'deduped to one');
  assert.equal(a[0].last_seen, '9');
  assert.equal(a[0].status, 'active');
  assert.equal(a[0].confidence, 'high');
});

test('3d: when active_entities exist, the newest V2 entity beats a stale V1 active_entity', () => {
  const s = validateState({
    active_entity: { type: 'order', ref: 'old_order', label: 'طلب قديم' }, // stale V1
    active_entities: [{ type: 'product', ref: 'fresh', label: 'منتج حديث', last_seen: '9' }],
  });
  assert.equal(s.active_entity.ref, 'fresh');
});

test('3e: a pure V1 row (active_entity only) keeps active_entities [] and uses the explicit entity', () => {
  const s = validateState({ active_entity: { type: 'product', ref: 'x', label: 'X' } });
  assert.deepEqual(s.active_entities, []);
  assert.equal(s.active_entity.ref, 'x');
});

test('3f: context block lists entities newest-first', () => {
  const s = validateState({
    active_entities: [
      { type: 'product', ref: 'old', label: 'الأقدم', last_seen: '1' },
      { type: 'product', ref: 'new', label: 'الأحدث', last_seen: '9' },
    ],
  });
  const block = buildConversationStateBlock(s, { canInject: true });
  assert.ok(block.indexOf('الأحدث') < block.indexOf('الأقدم'), 'newest entity appears first');
});

// ══ Bug 4 — memory recency / cap ═══════════════════════════════════════════

test('4a: equal relevance+confidence, more than the limit → the NEWEST are selected, oldest dropped', () => {
  const mems = [];
  for (let i = 0; i < 8; i++) mems.push({ summary: `ملاحظة عن الاشتراك رقم ${i}`, source: 'customer', confidence: 'high', last_updated: String(i) });
  const s = validateState({ salient_memories: mems });
  const block = buildConversationStateBlock(s, { canInject: true, latestUserText: 'الاشتراك', maxChars: 4000 });
  assert.ok(block.includes('ملاحظة عن الاشتراك رقم 7'), 'newest (7) selected');
  assert.ok(!block.includes('ملاحظة عن الاشتراك رقم 0'), 'oldest (0) dropped by the limit, not the newest');
});

test('4b: a new high-value memory is NOT dropped for an equally-valued stale one at 51+ memories', () => {
  const many = [];
  for (let i = 0; i < 51; i++) many.push({ summary: `ذاكرة قديمة ${i}`, source: 'customer', confidence: 'high', last_updated: String(i) });
  many.push({ summary: 'ذاكرة جديدة عالية القيمة', source: 'customer', confidence: 'high', last_updated: '999' });
  const s = validateState({ salient_memories: many });
  assert.equal(s.salient_memories.length, 50);
  assert.ok(s.salient_memories.some((m) => m.summary === 'ذاكرة جديدة عالية القيمة'),
    'the newest high-value memory survives the cap over equally-valued stale ones');
});

// ══ Bug 5 — strict context budget ══════════════════════════════════════════

test('5a: final block length is ALWAYS <= configured maxChars', () => {
  const memories = [];
  for (let i = 0; i < 60; i++) memories.push({ summary: `تفصيل طويل جدا رقم ${i} حشو حشو حشو حشو حشو`, source: 'customer', confidence: 'high' });
  const big = {
    customer_goal: 'هدف طويل جدا '.repeat(10),
    active_topic: 'موضوع',
    active_entities: Array.from({ length: 20 }, (_, i) => ({ type: 'product', ref: `p${i}`, label: `منتج رقم ${i}`, last_seen: String(i) })),
    open_issues: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, summary: `مشكلة مفتوحة رقم ${i}`, status: 'open' })),
    resolved_issues: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, summary: `مشكلة محلولة رقم ${i}`, resolved_by: 'customer_confirmed' })),
    known_facts: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`مفتاح${i}`, `قيمة${i}`])),
    pending_expectation: { type: 'phone_number', purpose: 'طلب الدفع' },
    salient_memories: memories,
  };
  for (const budget of [400, 700, 1200, 2200]) {
    const block = buildConversationStateBlock(validateState(big), { canInject: true, latestUserText: 'مشكلة', maxChars: budget });
    assert.ok(block.length <= budget, `budget ${budget}: got ${block.length}`);
  }
});

test('5b: high-priority content (resolved refs + pending) survives even under a tight budget', () => {
  const memories = [];
  for (let i = 0; i < 30; i++) memories.push({ summary: `ذاكرة منخفضة الأولوية ${i} حشو حشو`, source: 'customer', confidence: 'low' });
  const s = validateState({
    last_turn_understanding: { resolved_references: [{ text: 'الطلب', entity: 'الطلب رقم 123', confidence: 'high' }] },
    pending_expectation: { type: 'order_id', purpose: 'متابعة' },
    salient_memories: memories,
  });
  const block = buildConversationStateBlock(s, { canInject: true, latestUserText: 'طلبي', maxChars: 500 });
  assert.ok(block.length <= 500);
  assert.ok(block.includes('الطلب رقم 123'), 'resolved reference (top priority) survives');
});
