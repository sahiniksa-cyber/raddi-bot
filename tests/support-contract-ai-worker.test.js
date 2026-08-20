'use strict';

// Customer-Service Contract — reply-pipeline integration (processAiReply).
// Proves the platform invariants end-to-end through the real worker path:
//   §8  exact screenshot regression (invented troubleshooting + deflection)
//   §4  no fake escalation: a handoff claim never ships without a real escalation
//   §9  multi-tenant: policy precedence per-tenant, no leakage, no-target safety
//   §14 adversarial bad drafts are corrected by the platform, not trusted
// All tenants are SYNTHETIC. The safe behavior runs WITHOUT any feature flag ON.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Scenario the mocks read from — set per test.
const S = { customerText: 'مرحبا', aiReply: 'أهلاً', config: {} };

const dbMock = {
  isConfigured: () => true,
  async query(sql) {
    const s = String(sql);
    if (s.includes('FROM conversations') && s.includes('WHERE id = $1') && s.includes('user_id = $2') && !s.includes('escalated_until')) {
      return { rows: [{ id: 'conv-1', sender: '966500000000@s.whatsapp.net', phone_number: '966500000000' }], rowCount: 1 };
    }
    if (s.includes('escalated_until') && s.includes('escalated_until > NOW()')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM messages') && s.includes("direction = 'inbound'") && s.includes('WHERE id = $1') && s.includes('user_id = $2')) {
      return { rows: [{ content: S.customerText }], rowCount: 1 };
    }
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return { rows: [{ id: 'inbound-1', content: S.customerText, provider_message_id: 'p-in-1', raw_payload: {}, inbound_seq: 5 }], rowCount: 1 };
    }
    if (s.includes('SELECT role, content, status, direction')) {
      return { rows: [{ role: 'user', content: S.customerText, status: 'queued_for_ai', direction: 'inbound' }], rowCount: 1 };
    }
    if (s.includes('escalation_threads') && s.includes('resolved_at IS NULL')) return { rows: [], rowCount: 0 };
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) return { rows: [{ id: 'assistant-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), { resolveConfigForAI: async () => S.config });
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), { checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }) });
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), { loadActiveLearnedReplies: async () => [] });
stub(path.resolve(__dirname, '..', 'src', 'workers', 'profile-extractor.js'), { getProfile: async () => null, extractAsync: () => {} });
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), { createMailer: () => null });

const enqueued = [];
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: { incomingMessages: 'incoming-messages', aiReplies: 'ai-replies', outgoingWhatsapp: 'outgoing-whatsapp' },
  enqueueOutgoingWhatsapp: async (payload) => {
    if (payload.escalation === true && S.failEscalationEnqueue) throw new Error('escalation enqueue boom');
    enqueued.push(payload);
    return { id: `out-${enqueued.length}` };
  },
  enqueueAiReply: async () => ({ id: 'ai-1' }),
});

stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() { this.lastDebug = { qualityGate: { intent: '' } }; }
  async getReply() { return S.aiReply; }
});

const { processAiReply } = require('../src/workers/ai-worker');

function job() {
  return { id: 'job-1', data: { userId: 'user-1', conversationId: 'conv-1', messageId: 'inbound-1', sender: '966500000000@s.whatsapp.net', providerMessageId: 'p-in-1' }, attemptsMade: 0 };
}
function reset() {
  enqueued.length = 0;
  S.failEscalationEnqueue = false;
  delete process.env.INSTRUCTION_ROUTING_ENABLED;
  delete process.env.SUPPORT_CONTRACT_ENABLED;
  delete process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
}
const ESCALATE_TENANT = () => ({
  learningEnabled: false, memoryMessages: 50,
  botInstructions: 'أسلوبك سعودي ومختصر جداً مع كل العملاء. أي مشكلة أو عطل يواجه العميل في الخدمة صعّدها فوراً للدعم.',
  escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
});
const customerOut = () => enqueued.find((e) => e.source === 'ai_reply');
const escalationOut = () => enqueued.find((e) => e.escalation === true);

const BAD_DRAFT = 'تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول، وإذا استمرت المشكلة بلغني عشان أرفع الموضوع للإدارة ونحلها لك بأسرع وقت';

// ── §8 exact screenshot regression ─────────────────────────────────────────
test('§8 screenshot: policy "any problem → escalate" (legacy free-text) — real escalation, concise ack, NO invented troubleshooting', async () => {
  reset();
  S.customerText = 'الاشتراك وقف عندي مشكلة';
  S.aiReply = BAD_DRAFT;
  S.config = {
    learningEnabled: false, memoryMessages: 50,
    botInstructions: 'تكلم بلهجة سعودية مختصرة وواضحة دائماً مع كل العملاء. أي مشكلة أو عطل يواجه العميل في الخدمة صعّدها فوراً للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
  };

  await processAiReply(job());

  const out = customerOut();
  assert.ok(out, 'customer reply enqueued');
  assert.doesNotMatch(out.reply, /الإنترنت|تسجيل الدخول/, 'invented troubleshooting must be gone');
  assert.doesNotMatch(out.reply, /إذا استمرت|إن استمرت/, 'the "if it persists" deflection must be gone');
  assert.ok(escalationOut(), 'a REAL escalation must have been enqueued');
  assert.ok(out.reply.length <= 160, `ack must be concise, got ${out.reply.length}`);
});

// ── §4 no fake escalation ──────────────────────────────────────────────────
test('§4 no fake escalation: a handoff claim with NO configured target is stripped, nothing enqueued', async () => {
  reset();
  S.customerText = 'عندي مشكلة في طلبي';
  S.aiReply = 'بأرفع الموضوع للإدارة ويتواصل معك الفريق قريباً';
  S.config = { learningEnabled: false, memoryMessages: 50, escalationContacts: [] };

  await processAiReply(job());

  const out = customerOut();
  assert.ok(out, 'customer reply enqueued');
  assert.doesNotMatch(out.reply, /الإدارة|يتواصل معك الفريق/, 'fake escalation claim must be stripped');
  assert.equal(escalationOut(), undefined, 'no real escalation could be enqueued (no target)');
  assert.ok(out.reply.trim().length >= 2, 'never an empty reply');
});

// ── Blocker 1: real escalation ordering + no false promise on failure ──────
test('Blocker 1: team escalation is enqueued BEFORE the customer acknowledgement', async () => {
  reset();
  S.customerText = 'الاشتراك وقف عندي مشكلة';
  S.aiReply = BAD_DRAFT;
  S.config = ESCALATE_TENANT();

  await processAiReply(job());

  const escIdx = enqueued.findIndex((e) => e.escalation === true);
  const custIdx = enqueued.findIndex((e) => e.source === 'ai_reply');
  assert.ok(escIdx >= 0, 'a real escalation must be enqueued');
  assert.ok(custIdx >= 0, 'a customer reply must be enqueued');
  assert.ok(escIdx < custIdx, 'team escalation must be enqueued BEFORE the customer acknowledgement');
});

test('Blocker 1: escalation enqueue FAILURE → no success-claiming ack, job retries (throws)', async () => {
  reset();
  S.failEscalationEnqueue = true;
  S.customerText = 'الاشتراك وقف عندي مشكلة';
  S.aiReply = BAD_DRAFT;
  S.config = ESCALATE_TENANT();

  await assert.rejects(processAiReply(job()), 'job must throw so it retries safely');
  assert.equal(customerOut(), undefined, 'NO customer acknowledgement may be sent when escalation failed');
});

// ── Blocker 2 (final): "any problem → escalate" fires on SEMANTIC problem intent,
//    not literal keywords, and stays tenant-scoped. ─────────────────────────────
for (const phrase of ['الاشتراك وقف', 'الخدمة ما تشتغل', 'ما عاد يفتح عندي', 'توقف فجأة']) {
  test(`Blocker 2: Tenant A escalates on "${phrase}" (no literal مشكلة/عطل word)`, async () => {
    reset();
    S.customerText = phrase;
    S.aiReply = 'جرب تسجيل الدخول من جديد'; // model tries to self-solve; policy must win
    S.config = ESCALATE_TENANT();
    await processAiReply(job());
    const esc = escalationOut();
    assert.ok(esc, `Tenant A must escalate on a problem stated as "${phrase}"`);
    assert.match(String(esc.sender), /96651111111/, 'to Support A');
    assert.doesNotMatch(customerOut().reply, /تسجيل الدخول/, 'no self-troubleshooting when policy escalates');
  });
}

test('Blocker 2: Tenant A does NOT escalate a normal (non-problem) question', async () => {
  reset();
  S.customerText = 'كم سعر الاشتراك السنوي؟';
  S.aiReply = 'الاشتراك السنوي بـ250 ريال شامل الضريبة.';
  S.config = ESCALATE_TENANT();
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'a plain price question must not escalate');
  assert.match(customerOut().reply, /250/, 'the normal answer is delivered');
});

test('Blocker 2: Tenant B (answer-first) does NOT escalate a problem immediately, no leak', async () => {
  reset();
  S.customerText = 'الاشتراك وقف'; // a clear problem, but B answers first
  S.aiReply = 'نتحقق من الاشتراك، جرّب تحدّث الصفحة والكود يوصلك.';
  S.config = {
    learningEnabled: false, memoryMessages: 50,
    botInstructions: 'لهجتك رسمية. مشكلة الاشتراك استخدم الخطوات الموثقة أولاً وصعّد فقط لو ما انحلّت للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966522222222' }],
  };
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'Tenant B answer-first policy must not escalate immediately');
  assert.doesNotMatch(customerOut().reply, /96651111111/, 'no Tenant A leak');
});

// ── Scoped-vs-global escalation policy (problem_intent scope) ────────────────
function tenantWith(botInstructions) {
  return {
    learningEnabled: false, memoryMessages: 50,
    botInstructions,
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
  };
}
const genericSelfSolve = 'جرب تحدّث الصفحة.';

test('scope: UNIVERSAL policy escalates a problem stated without keywords', async () => {
  reset();
  S.customerText = 'الاشتراك وقف';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة أو عطل في الخدمة صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'universal policy must escalate a real problem');
});

test('scope: PAYMENT-scoped policy escalates a PAYMENT problem', async () => {
  reset();
  S.customerText = 'عملية الدفع مرفوضة';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل الدفع صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'payment-scoped policy must escalate a payment problem');
});

test('scope: PAYMENT-scoped policy does NOT escalate an UNRELATED problem', async () => {
  reset();
  S.customerText = 'التطبيق ما يفتح';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل الدفع صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'a non-payment problem must NOT hit the payment policy');
});

test('scope: LOGIN-scoped policy does NOT escalate a shipping problem', async () => {
  reset();
  S.customerText = 'الشحنة ما وصلت';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل تسجيل الدخول صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'a shipping problem must NOT hit the login policy');
});

test('scope: LOGIN-scoped policy escalates a LOGIN problem', async () => {
  reset();
  S.customerText = 'ما اقدر اسجل دخول';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل تسجيل الدخول صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'login-scoped policy must escalate a login problem');
});

test('scope: UNKNOWN merchant scope (كوبونات) escalates a matching problem (not global)', async () => {
  reset();
  S.customerText = 'الكوبون ما يشتغل';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل الكوبونات صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'coupon-scoped policy must escalate a coupon problem via merchant-derived scope');
});

test('scope: UNKNOWN merchant scope (كوبونات) does NOT escalate an unrelated problem', async () => {
  reset();
  S.customerText = 'التطبيق ما يفتح';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل الكوبونات صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'unknown-scope policy must NOT become global');
});

test('scope: UNKNOWN scope (تفعيل) does NOT escalate an unrelated shipping problem', async () => {
  reset();
  S.customerText = 'الشحنة ما وصلت';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('مشاكل التفعيل صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'activation-scoped policy must not fire on shipping');
});

test('precedence: quantifier + UNKNOWN scope escalates a matching problem (not global)', async () => {
  reset();
  S.customerText = 'الكوبون ما يشتغل';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة في الكوبونات صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'coupon-scoped (with quantifier) must escalate a coupon problem');
});

test('precedence: quantifier + UNKNOWN scope does NOT escalate an unrelated problem', async () => {
  reset();
  S.customerText = 'التطبيق ما يفتح';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة في الكوبونات صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'quantifier must NOT make a specific scope global');
});

test('precedence: quantifier + UNKNOWN scope (تفعيل) does NOT fire on shipping', async () => {
  reset();
  S.customerText = 'الشحنة ما وصلت';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة في التفعيل صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'activation scope must not fire on shipping');
});

test('precedence: pure universal (no scope) still escalates', async () => {
  reset();
  S.customerText = 'التطبيق ما يفتح';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة صعّدها للدعم.');
  await processAiReply(job());
  assert.ok(escalationOut(), 'pure universal must escalate any problem');
});

test('precedence: quantifier + RECOGNIZED scope (الدفع) does NOT fire on app failure', async () => {
  reset();
  S.customerText = 'التطبيق ما يفتح';
  S.aiReply = genericSelfSolve;
  S.config = tenantWith('أي مشكلة في الدفع صعّدها للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'payment-scoped must not fire on app failure');
});

test('scope: Tenant B deferred policy never escalates immediately (scoped or not)', async () => {
  reset();
  S.customerText = 'عملية الدفع مرفوضة';
  S.aiReply = 'نتحقق ونعطيك الحل الموثق.';
  S.config = tenantWith('استخدم الحلول الموثقة أولاً وصعّد فقط لو ما انحل للدعم.');
  await processAiReply(job());
  assert.equal(escalationOut(), undefined, 'deferred policy must not escalate immediately');
});

// ── §9 multi-tenant proof ──────────────────────────────────────────────────
test('§9 Tenant A: service issue → Support A escalation, concise, no troubleshooting', async () => {
  reset();
  S.customerText = 'في مشكلة بالخدمة عندي';
  S.aiReply = BAD_DRAFT;
  S.config = {
    learningEnabled: false, memoryMessages: 50,
    botInstructions: 'أسلوبك سعودي ومختصر جداً في كل الردود مع العملاء. أي مشكلة أو عطل في الخدمة صعّدها للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
  };

  await processAiReply(job());

  const esc = escalationOut();
  assert.ok(esc, 'Support A escalation fired');
  assert.match(String(esc.sender), /96651111111/, 'escalation went to Support A destination');
  assert.doesNotMatch(customerOut().reply, /الإنترنت|تسجيل الدخول/, 'no invented troubleshooting');
});

test('§9 Tenant B: answer-first policy (deferred escalation) → verified answer, NO escalation, no Support A leak', async () => {
  reset();
  S.customerText = 'ما أقدر أسجل دخول';
  S.aiReply = 'خطوات الدخول: افتح الصفحة واستخدم بريدك وكلمة المرور، والكود يوصلك على جوالك.';
  S.config = {
    learningEnabled: false, memoryMessages: 50,
    botInstructions: 'لهجتك رسمية وراقية. مشكلة تسجيل الدخول استخدم الخطوات الموثقة أولاً وصعّد فقط لو ما انحلّت للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966522222222' }],
  };

  await processAiReply(job());

  assert.equal(escalationOut(), undefined, 'Tenant B answer-first policy must NOT escalate immediately');
  const out = customerOut();
  assert.ok(out, 'customer reply enqueued');
  assert.doesNotMatch(out.reply, /96651111111/, 'no Support A leakage from Tenant A');
  assert.match(out.reply, /الدخول|الكود|بريدك/, 'the verified answer is delivered');
});

test('§9 no-target: policy would escalate but the named target does not resolve → no fake claim, safe ack', async () => {
  reset();
  S.customerText = 'عندي مشكلة كبيرة';
  S.aiReply = 'بسجل طلبك ويتواصل معك المختص قريباً';
  S.config = {
    learningEnabled: false, memoryMessages: 50,
    // directive names a target that is NOT in escalationContacts → unresolvable
    botInstructions: 'أي مشكلة صعّدها لسمير المسؤول.',
    escalationContacts: [{ name: 'قسم المبيعات', phone: '966533333333' }],
  };

  await processAiReply(job());

  assert.equal(escalationOut(), undefined, 'no escalation when the target cannot be resolved');
  const out = customerOut();
  assert.doesNotMatch(out.reply, /بسجل طلبك|يتواصل معك المختص/, 'no fake "registered/will contact" promise');
  assert.ok(out.reply.trim().length >= 2, 'safe non-empty ack');
});

// ── §14 adversarial drafts corrected by the platform ───────────────────────
for (const draft of [
  'جرب الإنترنت وإذا ما ضبط بأراجع الإدارة',
  'بسأل المختص وأرجع لك',
  'بيتواصل معك الفريق',
]) {
  test(`§14 adversarial (no target): "${draft.slice(0, 20)}…" → claim/troubleshooting removed, nothing faked`, async () => {
    reset();
    S.customerText = 'عندي استفسار';
    S.aiReply = draft;
    S.config = { learningEnabled: false, memoryMessages: 50, escalationContacts: [] };

    await processAiReply(job());

    const out = customerOut();
    assert.ok(out, 'customer reply enqueued');
    assert.doesNotMatch(out.reply, /الإدارة|المختص|يتواصل معك الفريق|الإنترنت/, `adversarial claim/troubleshooting survived: ${out.reply}`);
    assert.equal(escalationOut(), undefined, 'no fake escalation');
  });
}

test('§12 kill-switch SUPPORT_CONTRACT_ENABLED=false → contract does not alter the draft', async () => {
  reset();
  process.env.SUPPORT_CONTRACT_ENABLED = 'false';
  S.customerText = 'عندي مشكلة';
  S.aiReply = 'تأكد من اتصالك بالإنترنت'; // ungrounded — would normally be stripped
  S.config = { learningEnabled: false, memoryMessages: 50, escalationContacts: [] };

  await processAiReply(job());

  assert.match(customerOut().reply, /الإنترنت/, 'kill-switch keeps the raw draft for rollback');
});
