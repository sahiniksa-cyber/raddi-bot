'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExtractionRequest, EXTRACTION_SYSTEM_PROMPT, reconcileSystemState,
} = require('../src/services/ai/conversation-state');

// ── V2 extraction is ONE call that also resolves references, detects
// corrections, maintains pending expectation and salient memory (spec §18). ──

test('extraction prompt instructs the model to produce every V2 slot in ONE response', () => {
  const p = EXTRACTION_SYSTEM_PROMPT;
  assert.ok(/active_entities/.test(p), 'must ask for active_entities');
  assert.ok(/resolved_references/.test(p), 'must ask for resolved references');
  assert.ok(/pending_expectation/.test(p), 'must ask for pending_expectation');
  assert.ok(/salient_memories/.test(p), 'must ask for salient_memories');
  assert.ok(/last_turn_understanding/.test(p), 'must ask for last_turn_understanding');
  // Reference-resolution + correction reasoning are described.
  assert.ok(/reference|ضمير|الاشتراك|resolve|يقصد/i.test(p), 'must describe reference resolution');
  assert.ok(/correct|صحّح|صحح|غيّر|غير اختيار/i.test(p), 'must describe corrections');
});

test('extraction prompt keeps the hallucination-safety contract (§9): bot claims never become known_facts', () => {
  const p = EXTRACTION_SYSTEM_PROMPT;
  assert.ok(/known_facts/.test(p));
  assert.ok(/previous_bot_statement/.test(p), 'bot self-claims are routed to previous_bot_statement');
  // still forbids the model from stamping system-owned truth
  assert.ok(/النظام|system/.test(p));
});

test('extraction prompt has no banned self-referential words and still mentions handoff ownership', () => {
  const sys = EXTRACTION_SYSTEM_PROMPT.toLowerCase();
  for (const banned of ['chatgpt', 'openai', 'claude', 'as an ai', 'language model']) {
    assert.ok(!sys.includes(banned), `system prompt leaks "${banned}"`);
  }
  assert.ok(/resolved_issues/.test(EXTRACTION_SYSTEM_PROMPT));
  assert.ok(/handoff|تحويل|النظام/.test(EXTRACTION_SYSTEM_PROMPT));
});

test('buildExtractionRequest stays a single JSON call within the token budget (§18/§23)', () => {
  const req = buildExtractionRequest({
    previousState: { active_topic: 'prior', active_entities: [{ type: 'product', ref: 'a', label: 'A' }] },
    newTurns: [{ role: 'user', content: 'الاشتراك مضمون؟' }],
    lastBotReply: 'أي باقة تحب؟',
  });
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].role, 'user');
  assert.ok(req.max_tokens > 0 && req.max_tokens <= 700);
  assert.ok(req.temperature <= 0.3);
  assert.equal(req.response_format.type, 'json_object');
  // prior state + new turns + last bot reply all present so the model can resolve
  assert.ok(req.messages[1].content.includes('الاشتراك مضمون؟'));
  assert.ok(req.messages[1].content.includes('prior'));
  assert.ok(req.messages[1].content.includes('أي باقة تحب؟'));
});

test('reconcileSystemState preserves V2 slots while stamping system-owned truth', () => {
  const out = reconcileSystemState({
    active_entities: [{ type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe', last_seen: '5' }],
    pending_expectation: { type: 'phone_number', purpose: 'payment' },
    salient_memories: [{ summary: 'يريد السنوي', source: 'customer', confidence: 'high' }],
    last_turn_understanding: { intent: 'ask_warranty', resolved_references: [{ text: 'الاشتراك', entity: 'اشتراك Adobe', confidence: 'high' }] },
    resolved_issues: [{ id: 'x', summary: 'owner closed', resolved_by: 'owner' }],
    actions_attempted: [{ action: 'refund', outcome: 'worked', confirmed_by: 'system' }],
  }, { escalationPending: true });
  // V2 slots survive
  assert.equal(out.active_entities.length, 1);
  assert.equal(out.pending_expectation.type, 'phone_number');
  assert.equal(out.salient_memories[0].summary, 'يريد السنوي');
  assert.equal(out.last_turn_understanding.resolved_references[0].entity, 'اشتراك Adobe');
  assert.equal(out.active_entity.ref, 'adobe'); // derived
  // system-owned truth still enforced
  assert.equal(out.resolved_issues.find((i) => i.resolved_by === 'owner'), undefined);
  assert.equal(out.actions_attempted[0].confirmed_by, null);
  assert.equal(out.system.escalationPending, true);
});
