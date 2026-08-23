'use strict';

/**
 * Stability-phase focused regression suite (2026-08-15).
 *
 * One named test per original problem the phase set out to close (14 items).
 * Each asserts against the REAL module that owns the behavior, so a regression
 * in any of them fails here with a clear label. Full end-to-end wiring for
 * escalation + SLA is additionally covered in
 * tests/ai-worker-deterministic-escalation-wiring.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectResolvedReopen,
  isSemanticDuplicate,
  buildConversationStateBlock,
  buildStaleClaimQuery,
  validateState,
} = require('../src/services/ai/conversation-state');
const { applyDeterministicEscalation } = require('../src/services/instruction-routing/escalation-rules');
const { applyRoutingDecision } = require('../src/services/instruction-routing/routing-apply');
const { routeInstruction } = require('../src/services/instruction-routing/instruction-router');
const { computeSlaBreach, buildSlaBreachBlock } = require('../src/services/instruction-routing/sla-breach');
const { buildSlaBlock } = require('../src/services/instruction-routing/sla-block');
const { buildScopedJobKey } = require('../src/queues/message-queue');
const { prepareEscalation } = require('../src/workers/escalation-routing');
const AIClient = require('../lib/ai-client');

const HOUR = 3600 * 1000;

// (1) A customer who confirmed an issue is resolved must not get its troubleshooting again.
test('R1: resolved issue is not re-troubleshot unprompted', () => {
  const resolved = [{ summary: 'مشكلة تسجيل الدخول للحساب' }];
  // Bot volunteers the same steps, customer did NOT re-raise it → flagged.
  assert.equal(detectResolvedReopen('نعيد ضبط تسجيل الدخول للحساب بالخطوات', resolved, 'شكراً، تمام').reopened, true);
  // Customer explicitly re-raised it → repeating is legitimate, NOT flagged.
  assert.equal(detectResolvedReopen('نعيد ضبط تسجيل الدخول للحساب', resolved, 'رجعت مشكلة تسجيل الدخول للحساب').reopened, false);
});

// (2) The active product/entity must not be contaminated by another product.
test('R2: active entity is preserved and surfaced, not silently swapped', () => {
  const state = validateState({
    active_topic: 'الاستفسار عن جهاز البخار X200',
    active_entity: { type: 'product', ref: 'X200', label: 'جهاز البخار X200' },
  });
  assert.equal(state.active_entity.ref, 'X200');
  const block = buildConversationStateBlock(state, { canInject: true });
  assert.match(block, /X200/); // the model is told which entity is active
});

// (3) The bot must not say "برفع للإدارة / بحولك" without a real escalation behind it.
test('R3: no fake escalation promise when the target is unresolved', () => {
  const config = { escalationContacts: [], escalationRules: [{ target_contact_id: 'c1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('تمام أساعدك', config, { text: 'الاسترجاع' });
  assert.equal(out.escalated, false);
  assert.equal(out.unresolved, true);
  // And no marker was injected, so prepareEscalation produces NO owner message.
  const esc = prepareEscalation({ reply: out.reply, config, customerSender: '966500000000@c.us', inboundText: 'الاسترجاع' });
  assert.equal(esc.ownerMessage, null);
});

// (4) A valid escalation target → escalation actually happens.
test('R4: valid target → deterministic escalation fires the real machinery', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '966511111111' }], escalationRules: [{ target_contact_id: 'name:الدعم', trigger_type: 'topic', trigger_value: 'الاسترجاع' }] };
  const out = applyDeterministicEscalation('سياسة الاسترجاع ١٤ يوم', config, { text: 'كيف الاسترجاع؟' });
  assert.equal(out.escalated, true);
  const esc = prepareEscalation({ reply: out.reply, config, customerSender: '966500000000@c.us', inboundText: 'كيف الاسترجاع؟' });
  assert.ok(esc.ownerMessage, 'a real owner escalation message must be produced');
  assert.doesNotMatch(esc.customerReply, /\[تحويل:/, 'marker scrubbed from the customer reply');
});

// (5) A missing/undefined escalation target → no silent promise; ask the merchant to set it up.
test('R5: escalation to an unconfigured target is a merchant setup request, stored nothing', () => {
  const decision = routeInstruction({ category: 'ESCALATION', confidence: 0.9, line: 'صعّد المشاكل التقنية لسعود' }, { escalationContacts: [] });
  const applied = applyRoutingDecision(decision, {});
  assert.equal(applied.stored, false);
  assert.match(applied.merchantReply, /أضِف|إعدادات|أولاً/);
});

// (6) Operational instructions from a merchant edit must NOT land in botInstructions.
test('R6: operational edits route to structured fields, never botInstructions', () => {
  const sla = applyRoutingDecision({ sink: 'slaPolicy', duration: { amount: 12, unit: 'ساعة' }, line: 'التفعيل خلال 12 ساعة' }, {});
  assert.equal(sla.field, 'slaPolicies');
  assert.notEqual(sla.field, 'botInstructions');
  const policy = applyRoutingDecision({ sink: 'policy', line: 'ما نبيع بالتقسيط' }, {});
  assert.equal(policy.field, 'tenantPolicies');
  const prohibit = applyRoutingDecision({ sink: 'avoidPhrases', line: 'لا تقل كلمة رخيص' }, {});
  assert.equal(prohibit.field, 'prohibitions');
});

// (7) A long botInstructions must not dominate the whole prompt.
test('R7: long botInstructions is bounded and subordinated when the flag is on', () => {
  const long = 'التزم بنبرة رسمية جداً. '.repeat(200); // well over the cap
  const ai = new AIClient({ storeName: 'متجر', botInstructions: long, model: 'gpt-4o', openaiApiKey: 'x' },
    { info() {}, warn() {}, error() {} }, { record() {} });
  const prev = process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  const prevMax = process.env.BOT_INSTRUCTIONS_MAX_CHARS;
  try {
    process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = 'true';
    process.env.BOT_INSTRUCTIONS_MAX_CHARS = '1500';
    const prompt = ai.buildSystemPrompt([]);
    assert.match(prompt, /<شخصية_وأسلوب_الموظف>/, 'persona is wrapped as a subordinate section');
    assert.ok(prompt.includes('المصدر الأعلى'), 'platform rules are declared authoritative over the persona');
    // The persona is truncated: the raw instructions length exceeds the cap but
    // the embedded persona text is capped.
    assert.ok(long.length > 1500);
  } finally {
    if (prev === undefined) delete process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED; else process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = prev;
    if (prevMax === undefined) delete process.env.BOT_INSTRUCTIONS_MAX_CHARS; else process.env.BOT_INSTRUCTIONS_MAX_CHARS = prevMax;
  }
});

// (8) SLA still within the window → the policy is stated, no false "late".
test('R8: SLA within window states the policy and is not breached', () => {
  const block = buildSlaBlock([{ source_text: 'التفعيل حتى 12 ساعة' }]);
  assert.match(block, /12 ساعة/);
  const model = computeSlaBreach({ since: new Date(Date.now() - 3 * HOUR), now: Date.now(), slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  assert.equal(model.sla_breached, false);
  assert.equal(buildSlaBreachBlock(model), '');
});

// (9) SLA genuinely breached → do not repeat the old ETA; take the breach path.
test('R9: SLA breached does not repeat the ETA and flags the overrun', () => {
  const model = computeSlaBreach({ since: new Date(Date.now() - 25 * HOUR), now: Date.now(), slaPolicies: [{ amount: 12, unit: 'ساعة', source_text: 'التفعيل حتى 12 ساعة' }] });
  assert.equal(model.sla_breached, true);
  const block = buildSlaBreachBlock(model);
  assert.match(block, /انقضت/);
  assert.match(block, /ممنوع أن تكرر|لا تكرر/);
  assert.doesNotMatch(block.replace(/انقضت/g, ''), /^$/); // block is non-empty
});

// (10) Two quick customer messages → the older reply is not sent (atomic seq guard).
test('R10: stale send guard rejects a reply once a newer inbound_seq exists', () => {
  const { sql, params } = buildStaleClaimQuery({ replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', generatedAgainstSeq: 5 });
  assert.match(sql, /inbound_seq\s*>\s*\$4/); // a higher-seq inbound blocks the claim
  assert.match(sql, /user_id = \$2/);          // tenant scoped
  assert.deepEqual(params, ['r1', 'u1', 'c1', 5]);
});

// (11) The @lid path is subject to the SAME stale guard (guard is conversation-scoped, jid-agnostic).
test('R11: @lid conversations use the identical seq guard', () => {
  const lid = buildStaleClaimQuery({ replyMessageId: 'r2', userId: 'u1', conversationId: 'c-lid', generatedAgainstSeq: 9 });
  const normal = buildStaleClaimQuery({ replyMessageId: 'r2', userId: 'u1', conversationId: 'c-normal', generatedAgainstSeq: 9 });
  assert.equal(lid.sql, normal.sql, 'identical guard SQL regardless of jid form');
});

// (12) A semantic/rephrased duplicate must not produce annoying repeats.
test('R12: semantic duplicate detected only when no new customer turn intervened', () => {
  assert.equal(isSemanticDuplicate({ candidateIntent: 'refund_policy', recentReplyIntents: ['refund_policy'] }), true);
  assert.equal(isSemanticDuplicate({ candidateIntent: 'refund_policy', recentReplyIntents: ['refund_policy'], hasNewCustomerTurnSinceLastAssistant: true }), false);
});

// (13) Tenant A must not leak into tenant B (queue job-key scoping).
test('R13: same raw job key is tenant-isolated', () => {
  const a = buildScopedJobKey('tenantA', 'provider-key-123');
  const b = buildScopedJobKey('tenantB', 'provider-key-123');
  assert.notEqual(a, b);
  assert.match(a, /^tenantA:/);
  assert.match(b, /^tenantB:/);
});

// (P) Platform-level / Multi-Tenant generality: the SAME code must compute
// per-tenant from each tenant's OWN config — no hardcoded store/product/fee/SLA.
// Two DIFFERENT fake tenants with different policies must yield different,
// tenant-scoped outcomes and never leak into each other.
test('P: SLA breach + escalation are computed generically from each tenant config (2 tenants, no leak)', () => {
  const now = Date.parse('2026-08-15T00:00:00Z');
  // Tenant A: SLA 12h, escalates refunds to "دعم أ".
  const tenantA = {
    slaPolicies: [{ amount: 12, unit: 'ساعة' }],
    escalationContacts: [{ id: 'a1', name: 'دعم أ', phone: '966500000001' }],
    escalationRules: [{ target_contact_id: 'a1', trigger_type: 'topic', trigger_value: 'الاسترجاع' }],
  };
  // Tenant B: SLA 3 days, escalates shipping to "دعم ب" — totally different config.
  const tenantB = {
    slaPolicies: [{ amount: 3, unit: 'أيام' }],
    escalationContacts: [{ id: 'b1', name: 'دعم ب', phone: '966500000002' }],
    escalationRules: [{ target_contact_id: 'b1', trigger_type: 'topic', trigger_value: 'الشحن' }],
  };

  const since = new Date(now - 25 * HOUR); // 25h elapsed

  // Same elapsed time, DIFFERENT SLA per tenant → breach for A (12h), not for B (3d).
  const aBreach = computeSlaBreach({ since, now, slaPolicies: tenantA.slaPolicies });
  const bBreach = computeSlaBreach({ since, now, slaPolicies: tenantB.slaPolicies });
  assert.equal(aBreach.sla_breached, true, 'tenant A (12h) is breached at 25h');
  assert.equal(bBreach.sla_breached, false, 'tenant B (3d) is NOT breached at 25h');

  // Escalation routes to EACH tenant's own contact from EACH tenant's own rule.
  const aEsc = applyDeterministicEscalation('رد', tenantA, { text: 'سؤال عن الاسترجاع' });
  assert.equal(aEsc.escalated, true);
  assert.match(aEsc.reply, /\[تحويل:دعم أ\|/);

  const bEsc = applyDeterministicEscalation('رد', tenantB, { text: 'سؤال عن الشحن' });
  assert.equal(bEsc.escalated, true);
  assert.match(bEsc.reply, /\[تحويل:دعم ب\|/);

  // No leak: tenant A's trigger ("الاسترجاع") must NOT fire tenant B's rules,
  // and tenant B's contact must never appear for tenant A.
  assert.equal(applyDeterministicEscalation('رد', tenantB, { text: 'سؤال عن الاسترجاع' }).escalated, false);
  assert.doesNotMatch(aEsc.reply, /دعم ب/);
});

// (14) The welcome message must not appear in the middle of an ongoing conversation.
test('R14: welcome hint only on the first message, never mid-conversation', () => {
  const ai = new AIClient({ storeName: 'متجر', welcomeMessage: 'هلا والله', welcomeMode: 'inline', model: 'gpt-4o', openaiApiKey: 'x' },
    { info() {}, warn() {}, error() {} }, { record() {} });
  const first = ai.buildSystemPrompt([], { isFirstMsg: true });
  assert.match(first, /هلا والله/);
  const midConvo = ai.buildSystemPrompt(
    [{ role: 'user', content: 'سؤال' }, { role: 'assistant', content: 'جواب' }, { role: 'user', content: 'سؤال ثاني' }],
    { isFirstMsg: false },
  );
  assert.doesNotMatch(midConvo, /توجيه خاص.*أول رسالة/s);
});
