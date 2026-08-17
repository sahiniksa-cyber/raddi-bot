'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../scripts/context-engine-v2-live');

// Verifies the LIVE harness is COMPLETE and its guards are STRICT (they FAIL when
// they should). The live RUN itself is BLOCKED without a staging key; these unit
// tests prove the guards can't produce a false PASS.

const okCtx = () => ({
  extraction_ok: true, intent: 'ask', activeEntities: [], activeEntityLabel: null,
  resolvedReferences: [], pending: null, prevPending: null,
  priceStatus: 'not_a_calc', priceProductName: null, priceTotal: null,
  finalReply: 'رد عادي', escalated: false, resolvedIssues: [], openIssues: [], reopenedResolved: false,
});

test('A–H reference scenarios + payment are all present', () => {
  const ids = harness.scenarios.map((s) => s.id);
  for (const l of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) assert.ok(ids.some((id) => id.startsWith(`${l}:`)), `scenario ${l} missing`);
  assert.ok(ids.some((id) => id.startsWith('PAYMENT')));
});

test('GUARD 1/5: any expectation FAILS when extraction_ok !== true on that turn', () => {
  const ctx = { ...okCtx(), extraction_ok: false };
  const r = harness.checkExpect({ noEscalation: true }, ctx);
  assert.equal(r.pass, false);
  assert.ok(r.notes.some((n) => /extraction_ok/.test(n)));
  // and it PASSES when extraction succeeded and nothing else is violated
  assert.equal(harness.checkExpect({ noEscalation: true }, okCtx()).pass, true);
});

test('GUARD B: selectedProduct requires a COMPUTED price for that exact product', () => {
  // mere presence of بيتا in memory is NOT enough — price must be computed to it
  const notComputed = { ...okCtx(), activeEntities: [{ label: 'برنامج بيتا' }], priceStatus: 'no_reference', priceProductName: null };
  assert.equal(harness.checkExpect({ selectedProduct: 'بيتا', total: 200 }, notComputed).pass, false);
  const computed = { ...okCtx(), priceStatus: 'computed', priceProductName: 'برنامج بيتا', priceTotal: 200, finalReply: 'السعر 200' };
  assert.equal(harness.checkExpect({ selectedProduct: 'بيتا', total: 200 }, computed).pass, true);
  // wrong total fails
  assert.equal(harness.checkExpect({ selectedProduct: 'بيتا', total: 999 }, computed).pass, false);
});

test('GUARD F: pending lifecycle — asked, becomes phone, cleared, not re-asked', () => {
  // botAsksPhone fails if the reply does not ask for a phone
  assert.equal(harness.checkExpect({ botAsksPhone: true }, { ...okCtx(), finalReply: 'تمام' }).pass, false);
  assert.equal(harness.checkExpect({ botAsksPhone: true }, { ...okCtx(), finalReply: 'عطني رقم جوالك' }).pass, true);
  // pendingBecomes fails when no phone expectation set
  assert.equal(harness.checkExpect({ pendingBecomes: 'phone' }, okCtx()).pass, false);
  assert.equal(harness.checkExpect({ pendingBecomes: 'phone' }, { ...okCtx(), pending: { type: 'phone_number' } }).pass, true);
  // pendingCleared fails if there was no prior phone expectation, or it wasn't cleared
  assert.equal(harness.checkExpect({ pendingCleared: true }, okCtx()).pass, false);
  assert.equal(harness.checkExpect({ pendingCleared: true }, { ...okCtx(), prevPending: { type: 'phone_number' }, pending: { type: 'phone_number' } }).pass, false);
  assert.equal(harness.checkExpect({ pendingCleared: true }, { ...okCtx(), prevPending: { type: 'phone_number' }, pending: null }).pass, true);
  // replyNotAskingPhone fails if the bot re-asks
  assert.equal(harness.checkExpect({ replyNotAskingPhone: true }, { ...okCtx(), finalReply: 'وش رقم جوالك؟' }).pass, false);
});

test('GUARD G: resolved/open issues must exist, and no reopen of the resolved one', () => {
  const good = { ...okCtx(), resolvedIssues: [{ summary: 'تسجيل الدخول' }], openIssues: [{ summary: 'تفعيل المنتج' }], reopenedResolved: false };
  assert.equal(harness.checkExpect({ resolvedIncludes: 'دخول', openIncludes: 'تفعيل', noReopenOf: 'دخول' }, good).pass, true);
  // missing resolved issue → fail
  assert.equal(harness.checkExpect({ resolvedIncludes: 'دخول' }, okCtx()).pass, false);
  // reopened → fail
  assert.equal(harness.checkExpect({ noReopenOf: 'دخول' }, { ...good, reopenedResolved: true }).pass, false);
});

test('50-TURN stability verdict is PASS only at a full 50/50', () => {
  assert.equal(harness.stabilityVerdict(50, 50, 50), 'PASS');
  assert.equal(harness.stabilityVerdict(49, 50, 50), 'FAIL');
  assert.equal(harness.stabilityVerdict(50, 49, 50), 'FAIL');
  const fifty = harness.buildFiftyTurnScenario();
  assert.equal(fifty.turns.length, 50);
  assert.ok(fifty.stability === true);
});

test('TOKEN METRICS verdict is PASS only with enough real samples, else BLOCKED', () => {
  assert.equal(harness.tokenMetricsVerdict([]), 'BLOCKED');
  assert.equal(harness.tokenMetricsVerdict(new Array(5).fill(100)), 'BLOCKED');
  assert.equal(harness.tokenMetricsVerdict(new Array(20).fill(100)), 'PASS');
  assert.equal(harness.outputTokensOf({ completion_tokens: 123 }), 123);
  assert.equal(harness.outputTokensOf({ output_tokens: 77 }), 77);
  assert.equal(harness.outputTokensOf(null), null);
});

test('extractWithUsage returns usage and preserves older memories (faithful mirror)', async () => {
  const stubAi = { raw: async () => ({ usage: { completion_tokens: 250 }, choices: [{ message: { content: JSON.stringify({ active_topic: 'x', salient_memories: [{ summary: 'جديد', source: 'customer' }] }) } }] }) };
  const out = await harness.extractWithUsage(stubAi, {
    previousState: { salient_memories: [{ summary: 'قديم', source: 'customer', last_updated: '1' }] },
    newTurns: [{ role: 'user', content: 'مرحبا' }],
  });
  assert.equal(out.extraction_ok, true);
  assert.equal(out.usage.completion_tokens, 250);
  assert.ok(out.state.salient_memories.some((m) => m.summary === 'قديم'));
  assert.ok(out.state.salient_memories.some((m) => m.summary === 'جديد'));
});

test('every scenario expectation implicitly requires extraction (no requiresExtraction:false leaks)', () => {
  for (const sc of harness.scenarios) {
    const turns = sc.build ? sc.build() : sc.turns;
    for (const t of turns) {
      if (t.expect) assert.notEqual(t.expect.requiresExtraction, false, `${sc.id}: an expectation opted out of the extraction guard`);
    }
  }
});

// ── Anti-false-pass: escalation is detected AFTER the last layer, not after getReply ──

const ESC_CONFIG = {
  escalationContacts: [{ id: 'c1', name: 'المدير', phone: '966500000000' }],
  escalationRules: [{ trigger_type: 'keyword', trigger_value: 'مدير', target_contact_id: 'c1' }],
};
const passThroughReview = async ({ draft }) => ({ reply: draft, suppressed: false, requiresHuman: false, audit: {} });

test('FALSE-PASS 1: clean draft but DETERMINISTIC escalation fires → harness reports escalated', async () => {
  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  const res = await harness.runSendPipeline({
    config: ESC_CONFIG, history: [], latestUserText: 'أبي أكلم مدير', state: {}, canInject: false,
    getReplyImpl: async () => 'تمام أقدر أساعدك في طلبك', // NORMAL draft, no marker
    reviewBeforeSend: passThroughReview,
  });
  assert.equal(res.escalated, true, 'deterministic escalation must be detected in the live path');
  assert.ok(!/\[تحويل:/.test(res.finalText), 'marker stripped from the final customer text');
  process.env.INSTRUCTION_ROUTING_ENABLED = prev;
});

test('FALSE-PASS 2: clean draft but PRE-SEND REVIEW returns a handoff → harness reports escalated at the boundary', async () => {
  const res = await harness.runSendPipeline({
    config: { escalationContacts: [{ id: 'c1', name: 'الدعم', phone: '966500000000' }] },
    history: [], latestUserText: 'عندي مشكلة معقدة', state: {}, canInject: false,
    getReplyImpl: async () => 'رد عادي بدون أي تصعيد', // clean AFTER getReply
    reviewBeforeSend: async ({ draft }) => ({ reply: `${draft} [تحويل:الدعم|طلب دعم بشري]`, suppressed: false, requiresHuman: true, audit: { requiresHuman: true } }),
  });
  assert.equal(res.escalated, true, 'escalation introduced by the pre-send review must be detected');
  assert.ok(!/\[تحويل:/.test(res.finalText), 'final send-boundary text has the marker stripped');
});

test('pre-send review SUPPRESS → final status is suppressed, not a successful reply', async () => {
  const res = await harness.runSendPipeline({
    config: {}, history: [], latestUserText: 'شكراً', state: {}, canInject: false,
    getReplyImpl: async () => 'العفو، تم', reviewBeforeSend: async () => ({ suppressed: true, reply: '' }),
  });
  assert.equal(res.status, 'suppressed');
  assert.equal(res.suppressed, true);
  assert.equal(res.finalText, null);
});

test('FINAL TEXT is the actual send-boundary text (post-review rewrite), not the getReply draft', async () => {
  const res = await harness.runSendPipeline({
    config: {}, history: [], latestUserText: 'كم السعر؟', state: {}, canInject: false,
    getReplyImpl: async () => 'مسودة أولية طويلة',
    reviewBeforeSend: async () => ({ reply: 'النص المنقّح النهائي', suppressed: false, requiresHuman: false }),
  });
  assert.equal(res.finalText, 'النص المنقّح النهائي');
  assert.notEqual(res.finalText, res.draft);
});

// F/H assertion accuracy (harness heuristics fixed for the live false negatives).
test('replyNotAskingPhone: a CONFIRMATION mentioning the phone is not a re-ask', () => {
  const ctx = { ...okCtx(), finalReply: 'شكرًا لك! سأرسل طلب الدفع لرقم الجوال الآن.' };
  assert.equal(harness.checkExpect({ replyNotAskingPhone: true }, ctx).pass, true);
});
test('botAsksPhone: a real request passes; a mere mention does not falsely pass', () => {
  assert.equal(harness.checkExpect({ botAsksPhone: true }, { ...okCtx(), finalReply: 'ممكن رقم جوالك؟' }).pass, true);
  assert.equal(harness.checkExpect({ botAsksPhone: true }, { ...okCtx(), finalReply: 'سأرسل الطلب لرقم الجوال.' }).pass, false);
});
test('intent match accepts an installment-phrased payment selection', () => {
  const ctx = { ...okCtx(), intent: 'inquire about installment options' };
  assert.equal(harness.checkExpect({ intentIncludes: ['payment', 'دفع', 'select', 'install', 'تقسيط'] }, ctx).pass, true);
});

test('normal reply through the full pipeline does NOT escalate (no false positive)', async () => {
  const res = await harness.runSendPipeline({
    config: { escalationContacts: [{ id: 'c1', name: 'الدعم', phone: '966500000000' }] },
    history: [], latestUserText: 'كم سعر الاشتراك؟', state: {}, canInject: false,
    getReplyImpl: async () => 'السعر 189 ريال', reviewBeforeSend: passThroughReview,
  });
  assert.equal(res.escalated, false);
  assert.equal(res.finalText, 'السعر 189 ريال');
});
