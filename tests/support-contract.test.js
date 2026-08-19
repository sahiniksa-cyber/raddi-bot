'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  detectActionClaim,
  stripActionClaims,
  hasGroundingSupport,
  detectGenericTroubleshooting,
  stripGenericTroubleshooting,
  deriveEscalationRulesFromInstructions,
  reconcileSupportReply,
  splitInstructionsForPrompt,
  buildHandoffAck,
  buildNeutralAck,
  detectProblemIntent,
} = require('../src/services/ai/support-contract');

// ── detectActionClaim — a reply that claims a handoff/review/callback happened ──
test('detectActionClaim: flags a transfer/handoff promise', () => {
  assert.equal(detectActionClaim('بأرفع الموضوع للإدارة ونرجع لك').claimed, true);
  assert.equal(detectActionClaim('بيتواصل معك الفريق قريباً').claimed, true);
  assert.equal(detectActionClaim('بسجل طلبك ويتم الرد عليك').claimed, true);
  assert.equal(detectActionClaim('بأراجع الإدارة وأرجع لك').claimed, true);
  assert.equal(detectActionClaim('بحوّلك للمختص').claimed, true);
});

test('detectActionClaim: a plain factual answer is NOT a claim', () => {
  assert.equal(detectActionClaim('سعر الاشتراك 250 ريال شامل الضريبة').claimed, false);
  assert.equal(detectActionClaim('نعم متوفر، تفضل الرابط').claimed, false);
  assert.equal(detectActionClaim('').claimed, false);
});

// ── stripActionClaims — remove the false promise, keep the real content ──
test('stripActionClaims: drops the claim clause, keeps genuine content', () => {
  const out = stripActionClaims('شكراً لتواصلك. بأرفع الموضوع للإدارة ونرجع لك بأقرب وقت');
  assert.ok(!/الإدارة|نرجع لك/.test(out), `claim survived: ${out}`);
  assert.ok(/شكرا/.test(out.replace(/[إأآا]/g, 'ا')), `real content lost: ${out}`);
});

test('stripActionClaims: a reply that is ONLY a claim collapses to empty', () => {
  const out = stripActionClaims('بيتواصل معك الفريق قريباً');
  assert.equal(out.trim(), '');
});

// ── hasGroundingSupport — a step must be backed by verified tenant knowledge ──
test('hasGroundingSupport: true when the step overlaps tenant knowledge', () => {
  const config = { botInstructions: 'لو ما فتح التطبيق أعد تسجيل الدخول من جديد' };
  assert.equal(hasGroundingSupport('أعد تسجيل الدخول', config), true);
});

test('hasGroundingSupport: false when nothing in config supports the step', () => {
  const config = { products: [{ name: 'اشتراك سنوي', price: '250' }] };
  assert.equal(hasGroundingSupport('تأكد من اتصالك بالإنترنت', config), false);
});

// Blocker 3 — ACTION-level grounding, not topic-token overlap.
test('hasGroundingSupport: a topic NOUN without the action is NOT grounding', () => {
  // the tenant mentions the login PAGE (a noun), never tells the customer to re-login
  const config = { botInstructions: 'صفحة تسجيل الدخول موجودة في أعلى الموقع الرسمي' };
  assert.equal(hasGroundingSupport('جرب تسجيل الدخول مرة ثانية', config), false);
});

test('hasGroundingSupport: a documented re-login IMPERATIVE grounds a re-login step', () => {
  const config = { botInstructions: 'إذا ما ظهر الكود أعد تسجيل الدخول ثم انتظر دقيقة' };
  assert.equal(hasGroundingSupport('جرب تسجيل الدخول مرة ثانية', config), true);
});

// Blocker 2 — grounding requires POSITIVE evidence (not prohibitions / negations).
test('grounding: a NEGATED instruction is NOT grounding', () => {
  const config = { botInstructions: 'لا تطلب من العميل إعادة تسجيل الدخول أبداً' };
  assert.equal(hasGroundingSupport('جرب تسجيل الدخول مرة ثانية', config), false);
});

test('grounding: a PROHIBITION field is NOT grounding', () => {
  const config = { prohibitions: ['إعادة التشغيل', 'مسح الكاش'] };
  assert.equal(hasGroundingSupport('أعد تشغيل الجهاز', config), false);
});

test('grounding: a "forbidden wording example" in botInstructions is NOT grounding', () => {
  const config = { botInstructions: 'ممنوع تقول للعميل: أعد تشغيل الجهاز.' };
  assert.equal(hasGroundingSupport('أعد تشغيل الجهاز', config), false);
});

// Blocker 3 — general procedural detector: novel actions (not in any blacklist)
// must still be caught and require positive grounding.
for (const step of ['عطّل الـVPN', 'غيّر صلاحيات التطبيق', 'أعد تعيين كلمة المرور', 'احذف الحساب وأضفه من جديد', 'امسح مساحة التخزين']) {
  test(`procedural (novel, ungrounded): "${step}" is detected AND unsupported`, () => {
    assert.ok(detectGenericTroubleshooting(step).length >= 1, `not detected as procedural: ${step}`);
    assert.equal(hasGroundingSupport(step, {}), false);
  });
}

test('procedural (grounded): the SAME documented action stays', () => {
  const config = { botInstructions: 'لو التطبيق يعلّق عطّل الـVPN ثم افتحه من جديد' };
  assert.equal(hasGroundingSupport('عطّل الـVPN', config), true);
});

// Blocker 1 (final) — grounding must match the SAME ACTION FAMILY + SAME object.
// An opposite action on the same object is a CONTRADICTION, not grounding.
const OPPOSITE_PAIRS = [
  ['فعّل الـVPN', 'عطّل الـVPN'],       // enable vs disable
  ['أضف الحساب', 'احذف الحساب'],        // add vs remove
  ['شغّل التطبيق', 'أوقف التطبيق'],      // start vs stop
];
for (const [documented, opposite] of OPPOSITE_PAIRS) {
  test(`grounding: opposite action, same object → NOT grounded ("${documented}" ⊬ "${opposite}")`, () => {
    const config = { botInstructions: `لو صار شي ${documented} من الإعدادات` };
    assert.equal(hasGroundingSupport(opposite, config), false, `"${documented}" wrongly grounded "${opposite}"`);
  });
  test(`grounding: same action, same object → grounded ("${documented}")`, () => {
    const config = { botInstructions: `لو صار شي ${documented} من الإعدادات` };
    assert.equal(hasGroundingSupport(documented, config), true);
  });
}

test('reconcile strips a NOVEL ungrounded procedural action', () => {
  const res = reconcileSupportReply({
    reply: 'عطّل الـVPN وغيّر صلاحيات التطبيق عشان يشتغل',
    config: {}, escalationEnqueued: false, escalationPolicyMatched: false, customerText: 'التطبيق ما يفتح',
  });
  assert.ok(!/VPN|صلاحيات/.test(res.reply), `novel invented procedure survived: ${res.reply}`);
  assert.ok(res.diagnostics.includes('ungrounded_troubleshooting_stripped'));
});

// Blocker 4 — platform safety fallbacks are TONE-NEUTRAL (no emoji / tenant style).
test('buildNeutralAck & buildHandoffAck are tone-neutral (no emoji)', () => {
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  assert.ok(!EMOJI.test(buildNeutralAck()), `neutral ack has emoji: ${buildNeutralAck()}`);
  assert.ok(!EMOJI.test(buildHandoffAck({})), `handoff ack has emoji: ${buildHandoffAck({})}`);
  assert.ok(!EMOJI.test(buildHandoffAck({ slaPolicies: [{ amount: 12, unit: 'ساعة' }] })), 'sla ack has emoji');
});

// ── detectGenericTroubleshooting — the invented IT-support clichés ──
test('detectGenericTroubleshooting: catches internet + re-login steps', () => {
  const steps = detectGenericTroubleshooting('تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول مرة ثانية');
  assert.ok(steps.length >= 2, `expected 2+ steps, got ${JSON.stringify(steps)}`);
});

test('detectGenericTroubleshooting: a normal product answer yields nothing', () => {
  const steps = detectGenericTroubleshooting('الاشتراك السنوي بـ250 ريال ويشمل كل المزايا');
  assert.deepEqual(steps, []);
});

// ── stripGenericTroubleshooting — only strips UNGROUNDED generic steps ──
test('stripGenericTroubleshooting: removes ungrounded generic steps', () => {
  const out = stripGenericTroubleshooting('تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول', {});
  assert.ok(!/الإنترنت/.test(out), `ungrounded internet step survived: ${out}`);
});

test('stripGenericTroubleshooting: KEEPS a step the tenant actually documented', () => {
  const config = { botInstructions: 'إذا ما ظهر الكود أعد تسجيل الدخول ثم جرب مرة ثانية' };
  const out = stripGenericTroubleshooting('أعد تسجيل الدخول وبيظهر الكود', config);
  assert.ok(/تسجيل الدخول/.test(out), `grounded step was wrongly stripped: ${out}`);
});

// ── deriveEscalationRulesFromInstructions — runtime shadow routing (no DB) ──
test('shadow routing: unconditional "any problem → escalate" yields a live rule', () => {
  const config = {
    botInstructions: 'تكلم سعودي ومختصر. أي مشكلة أو عطل في الخدمة صعّدها للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966500000001' }],
  };
  const rules = deriveEscalationRulesFromInstructions(config);
  assert.ok(rules.length >= 1, 'expected at least one synthesized escalation rule');
  // it must resolve to the tenant's real contact — never an invented target
  assert.ok(rules.every(r => r.target_contact_id), 'rule missing resolved target');
  // a customer problem report must be matchable by at least one derived trigger
  const norm = s => String(s).replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  const customer = norm('السلام عليكم عندي مشكلة الاشتراك وقف');
  assert.ok(
    rules.some(r => r.trigger_type !== 'intent' && customer.includes(norm(r.trigger_value))),
    `no derived trigger matched a problem report: ${JSON.stringify(rules)}`,
  );
});

// Blocker 2 (final) — problem/support intent is SEMANTIC, not literal keywords.
for (const msg of ['الاشتراك وقف', 'الخدمة ما تشتغل', 'ما عاد يفتح عندي', 'توقف فجأة', 'التطبيق يطلّع خطأ']) {
  test(`detectProblemIntent: true for "${msg}" (no literal مشكلة/عطل)`, () => {
    assert.equal(detectProblemIntent(msg), true);
  });
}
for (const msg of ['كم سعر الاشتراك؟', 'وش الباقات المتوفرة؟', 'أبغى أعرف مواعيد التوصيل']) {
  test(`detectProblemIntent: false for a normal question "${msg}"`, () => {
    assert.equal(detectProblemIntent(msg), false);
  });
}

// Blocker (final) — UNKNOWN scope must NEVER become global. Only an EXPLICIT
// universal quantifier yields global problem_intent.
function derive(botInstructions) {
  return deriveEscalationRulesFromInstructions({
    botInstructions,
    escalationContacts: [{ name: 'الدعم', phone: '966500000001' }],
  });
}

for (const uni of ['أي مشكلة صعّدها للدعم', 'كل المشاكل صعّدها للدعم', 'جميع الأعطال صعّدها للدعم', 'كافة المشاكل صعّدها للدعم', 'أي عطل في الخدمة صعّده للدعم']) {
  test(`scope: EXPLICIT universal → global problem_intent ("${uni.slice(0, 14)}…")`, () => {
    assert.ok(derive(uni).some(r => r.trigger_type === 'problem_intent'), `expected global for: ${uni}`);
  });
}

for (const scoped of ['مشاكل الكوبونات صعّدها للدعم', 'مشاكل التفعيل صعّدها للدعم', 'مشاكل التطبيق صعّدها للدعم', 'مشاكل الاسترجاع صعّدها للدعم', 'مشاكل الضمان صعّدها للدعم']) {
  test(`scope: UNKNOWN scope + no quantifier → NEVER global ("${scoped.slice(0, 16)}…")`, () => {
    const rules = derive(scoped);
    assert.ok(!rules.some(r => r.trigger_type === 'problem_intent'), `must NOT be global: ${scoped}`);
    assert.ok(rules.some(r => r.trigger_type === 'scoped_problem_keyword'), `expected a merchant-derived scoped rule: ${JSON.stringify(rules)}`);
  });
}

// SPECIFIC scope wins over UNIVERSALITY even when the scope is unknown/merchant-derived.
test('precedence: quantifier + UNKNOWN scope → scoped_problem_keyword, NOT global', () => {
  const rules = derive('أي مشكلة في الكوبونات صعّدها للدعم');
  assert.ok(!rules.some(r => r.trigger_type === 'problem_intent'), `must NOT be global: ${JSON.stringify(rules)}`);
  assert.ok(rules.some(r => r.trigger_type === 'scoped_problem_keyword'), 'expected merchant-derived coupon scope');
});

test('precedence: quantifier + RECOGNIZED scope → scoped_problem_intent, NOT global', () => {
  const rules = derive('أي مشكلة في الدفع صعّدها للدعم');
  assert.ok(!rules.some(r => r.trigger_type === 'problem_intent'), 'must NOT be global');
  assert.ok(rules.some(r => r.trigger_type === 'scoped_problem_intent' && r.trigger_value === 'PAYMENT'), 'expected payment scope');
});

test('precedence: quantifier with NO specific scope → global problem_intent', () => {
  const rules = derive('أي مشكلة صعّدها للدعم');
  assert.ok(rules.some(r => r.trigger_type === 'problem_intent'), 'expected global');
});

test('precedence: quantifier + whole-service (الخدمة) stays global', () => {
  const rules = derive('أي مشكلة أو عطل في الخدمة صعّدها للدعم');
  assert.ok(rules.some(r => r.trigger_type === 'problem_intent'), 'whole-service must remain global');
  assert.ok(!rules.some(r => r.trigger_type === 'scoped_problem_keyword'), 'service is not a specific token');
});

test('shadow routing: a general "any problem → escalate" yields a SEMANTIC problem_intent rule', () => {
  const config = {
    botInstructions: 'تكلم سعودي ومختصر. أي مشكلة أو عطل في الخدمة صعّدها للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966500000001' }],
  };
  const rules = require('../src/services/ai/support-contract').deriveEscalationRulesFromInstructions(config);
  assert.ok(rules.some(r => r.trigger_type === 'problem_intent' && r.target_contact_id),
    `expected a problem_intent rule, got ${JSON.stringify(rules)}`);
});

test('shadow routing: a DEFERRED "escalate only if unresolved" yields NO immediate rule', () => {
  const config = {
    botInstructions: 'مشكلة تسجيل الدخول استخدم الخطوات الموثقة أولاً وصعّد فقط لو ما انحلّت للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966500000002' }],
  };
  const rules = deriveEscalationRulesFromInstructions(config);
  assert.deepEqual(rules, [], 'deferred escalation must not become an immediate policy rule');
});

test('shadow routing: never invents a target when no contact resolves', () => {
  const config = {
    botInstructions: 'أي مشكلة صعّدها للدعم.',
    escalationContacts: [],
  };
  assert.deepEqual(deriveEscalationRulesFromInstructions(config), []);
});

test('shadow routing: no botInstructions → no rules (empty, safe)', () => {
  assert.deepEqual(deriveEscalationRulesFromInstructions({}), []);
});

// ── reconcileSupportReply — the customer-service decision contract ──
test('reconcile: escalation policy matched + real escalation → concise handoff, NO troubleshooting', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '966500000001' }] };
  const res = reconcileSupportReply({
    reply: 'تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول، وإذا استمرت المشكلة بلغني عشان أرفع الموضوع للإدارة',
    config,
    escalationEnqueued: true,
    escalationPolicyMatched: true,
    customerText: 'الاشتراك وقف عندي مشكلة',
  });
  assert.equal(res.decision, 'ESCALATE_REAL');
  assert.ok(!/الإنترنت|تسجيل الدخول/.test(res.reply), `invented troubleshooting leaked: ${res.reply}`);
  assert.ok(res.reply.length <= 160, `handoff ack not concise: ${res.reply}`);
});

// Blocker 5 — the ack must be honest: no time promise unless a documented SLA.
test('buildHandoffAck: NO time promise when the tenant has no documented SLA', () => {
  const ack = buildHandoffAck({ escalationContacts: [{ name: 'الدعم', phone: '1' }] });
  assert.ok(/رفع|رفعت|سجّل|سجل/.test(ack), `ack should state the real action: ${ack}`);
  assert.ok(!/بأقرب وقت|يتواصلون معك|خلال/.test(ack), `unfounded time/contact promise: ${ack}`);
});

test('buildHandoffAck: includes the documented SLA window when configured', () => {
  const ack = buildHandoffAck({ slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  assert.ok(/12/.test(ack) && /ساعة/.test(ack), `documented SLA missing from ack: ${ack}`);
});

test('reconcile: action claim WITHOUT a real escalation → claim stripped, no fake promise', () => {
  const res = reconcileSupportReply({
    reply: 'بأرفع الموضوع للإدارة ويتواصل معك الفريق قريباً',
    config: {},
    escalationEnqueued: false,
    escalationPolicyMatched: false,
    customerText: 'عندي مشكلة',
  });
  assert.ok(!/الإدارة|يتواصل معك الفريق/.test(res.reply), `fake escalation claim survived: ${res.reply}`);
  assert.ok(res.diagnostics.includes('claim_without_escalation'));
});

test('reconcile: ungrounded troubleshooting + no escalation → stripped', () => {
  const res = reconcileSupportReply({
    reply: 'تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول',
    config: {},
    escalationEnqueued: false,
    escalationPolicyMatched: false,
    customerText: 'التطبيق ما يفتح',
  });
  assert.ok(!/الإنترنت/.test(res.reply), `ungrounded troubleshooting survived: ${res.reply}`);
  assert.ok(res.diagnostics.includes('ungrounded_troubleshooting_stripped'));
});

test('reconcile: a clean verified answer passes through unchanged', () => {
  const reply = 'الاشتراك السنوي بـ250 ريال ويشمل كل المزايا 🌷';
  const res = reconcileSupportReply({
    reply, config: { products: [{ name: 'اشتراك سنوي', price: '250 ريال' }] },
    escalationEnqueued: false, escalationPolicyMatched: false, customerText: 'كم الاشتراك السنوي؟',
  });
  assert.equal(res.reply, reply);
  assert.equal(res.decision, 'ANSWER_VERIFIED');
});

test('reconcile: kill-switch SUPPORT_CONTRACT_ENABLED=false → verbatim passthrough', () => {
  const prev = process.env.SUPPORT_CONTRACT_ENABLED;
  process.env.SUPPORT_CONTRACT_ENABLED = 'false';
  try {
    const reply = 'بأرفع الموضوع للإدارة'; // would normally be stripped
    const res = reconcileSupportReply({
      reply, config: {}, escalationEnqueued: false, escalationPolicyMatched: false, customerText: 'مشكلة',
    });
    assert.equal(res.reply, reply);
  } finally {
    if (prev === undefined) delete process.env.SUPPORT_CONTRACT_ENABLED;
    else process.env.SUPPORT_CONTRACT_ENABLED = prev;
  }
});

// ── splitInstructionsForPrompt — §2/§10 persona vs operational facts ──
test('splitInstructionsForPrompt: style → persona, operational → facts (no loss)', () => {
  const { personaText, factsText } = splitInstructionsForPrompt(
    'تكلم سعودي ومختصر. أي مشكلة تواجه العميل صعّدها للدعم. لا تطول في الرد.',
  );
  assert.ok(/سعودي|مختصر/.test(personaText), `style not in persona: ${personaText}`);
  assert.ok(/صعّد|صعد/.test(factsText), `escalation directive not in facts: ${factsText}`);
  // the escalate directive must NOT sit in the persona (subordinate) text
  assert.ok(!/صعّدها للدعم/.test(personaText), 'operational directive leaked into persona');
});

test('splitInstructionsForPrompt: UNKNOWN stays in persona, never promoted to facts', () => {
  const { personaText, factsText } = splitInstructionsForPrompt('بلابلا كلام غير مصنّف تماماً هنا');
  assert.ok(personaText.includes('غير مصنّف') || personaText.length > 0);
  assert.equal(factsText.trim(), '');
});

test('reconcile: never returns an empty customer reply (safety floor)', () => {
  const res = reconcileSupportReply({
    reply: 'بيتواصل معك الفريق قريباً', // pure claim, no real escalation → would strip to empty
    config: {}, escalationEnqueued: false, escalationPolicyMatched: false, customerText: 'وينكم',
  });
  assert.ok(res.reply.trim().length >= 2, `reconciler produced empty reply: "${res.reply}"`);
});
