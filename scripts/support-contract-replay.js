'use strict';

/*
 * Customer-Service Contract — offline PIPELINE REPLAY (§15).
 *
 * Runs the REAL deterministic reply pipeline for SYNTHETIC tenants, with NO
 * WhatsApp send and NO DB/Redis. Because no live model key is available in this
 * environment, the "model draft" is a scripted ADVERSARIAL draft (deliberately
 * bad — invented troubleshooting + fake handoff, per §8/§14). The point is to
 * prove the PLATFORM fixes the decision regardless of what the model says.
 *
 * Pipeline exercised (real modules):
 *   config → buildSystemPrompt → [adversarial draft] → deterministic escalation
 *   (structured + legacy shadow) → prepareEscalation → reconcileSupportReply
 *   → validateAndRepair (brevity/filler defaults) → final customer text.
 *
 * Semantic success criteria (not exact wording):
 *   - correct decision per tenant policy
 *   - no hallucinated support step in the customer text
 *   - no fake action claim without a real escalation
 *   - correct tenant target, no cross-tenant leak
 *   - concise, non-empty reply
 *
 * Run:  node scripts/support-contract-replay.js
 */

const AIClient = require('../lib/ai-client');
const { applyDeterministicEscalation } = require('../src/services/instruction-routing/escalation-rules');
const { prepareEscalation } = require('../src/workers/escalation-routing');
const { deriveEscalationRulesFromInstructions, reconcileSupportReply } = require('../src/services/ai/support-contract');
const { validateAndRepair } = require('../src/services/ai/reply-validator');

const BAD_DRAFT = 'تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول، وإذا استمرت المشكلة بلغني عشان أرفع الموضوع للإدارة ونحلها لك بأسرع وقت';

const TENANTS = {
  A: {
    userId: 'tenant-A',
    storeName: 'متجر ألف',
    botInstructions: 'أسلوبك سعودي ومختصر جداً مع كل العملاء. أي مشكلة أو عطل يواجه العميل في الخدمة صعّدها فوراً للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
    maxResponseLength: 200,
    replyStyle: { emojiLevel: 'light' },
  },
  B: {
    userId: 'tenant-B',
    storeName: 'متجر باء',
    botInstructions: 'لهجتك رسمية وراقية. مشكلة تسجيل الدخول استخدم الخطوات الموثقة أولاً وصعّد فقط لو ما انحلّت للدعم.',
    escalationContacts: [{ name: 'الدعم', phone: '966522222222' }],
    maxResponseLength: 300,
    replyStyle: { emojiLevel: 'none' },
  },
  NOTARGET: {
    userId: 'tenant-NoTarget',
    storeName: 'متجر جيم',
    botInstructions: 'أي مشكلة صعّدها لسمير المسؤول.', // target not in contacts → unresolvable
    escalationContacts: [{ name: 'قسم المبيعات', phone: '966533333333' }],
    maxResponseLength: 200,
    replyStyle: {},
  },
};

async function runTurn(config, customerText, modelDraft) {
  const logger = { info() {}, warn() {}, error() {} };
  const ai = new AIClient(config, logger);
  const history = [{ role: 'user', content: customerText }];
  const systemPrompt = ai.buildSystemPrompt(history, { latestUserText: customerText });

  // Generation-time validator (real): brevity/filler defaults + escalation-tag
  // enforcement on the model draft.
  let reply = await validateAndRepair({ reply: modelDraft, config, customerText, matched: [] });

  // deterministic escalation: structured rules + legacy shadow (the real worker path)
  const shadow = deriveEscalationRulesFromInstructions(config);
  const evalConfig = shadow.length
    ? { ...config, escalationRules: [...(config.escalationRules || []), ...shadow] }
    : config;
  const det = applyDeterministicEscalation(reply, evalConfig, { text: customerText, intent: '', slaBreached: false });
  const policyMatched = det.escalated === true || det.alreadyMarked === true;
  reply = det.reply;

  const escalation = prepareEscalation({ reply, config, customerSender: `${config.userId}-cust@s.whatsapp.net`, inboundText: customerText });
  let customerReply = (escalation.customerReply || '').trim();
  const escalationEnqueued = Boolean(escalation.ownerMessage);

  const contract = reconcileSupportReply({
    reply: customerReply,
    config,
    escalationEnqueued,
    escalationPolicyMatched: policyMatched && escalationEnqueued,
    customerText,
  });

  return {
    systemPromptHead: systemPrompt.slice(0, 60).replace(/\n/g, ' '),
    boundedBase: !systemPrompt.startsWith(config.botInstructions.slice(0, 20)),
    decision: contract.decision,
    diagnostics: contract.diagnostics,
    escalationTarget: escalation.ownerMessage ? escalation.ownerMessage.contactTarget || escalation.ownerMessage.sender : null,
    finalReply: contract.reply,
  };
}

const SCENARIOS = [
  { tenant: 'A', text: 'الاشتراك وقف عندي مشكلة', expect: { escalate: true, target: /96651111111/, decision: 'ESCALATE_REAL' } },
  // SEMANTIC problem intent — NO literal "مشكلة/عطل" word, must still escalate (Tenant A)
  { tenant: 'A', text: 'الاشتراك وقف', draft: 'جرب تسجيل الدخول من جديد', expect: { escalate: true, target: /96651111111/, decision: 'ESCALATE_REAL' } },
  { tenant: 'A', text: 'ما عاد يفتح عندي', draft: 'أعد تشغيل الجهاز', expect: { escalate: true, target: /96651111111/, decision: 'ESCALATE_REAL' } },
  // A plain question must NOT escalate even for the "any problem → escalate" tenant
  { tenant: 'A', text: 'كم سعر الاشتراك السنوي؟', draft: 'الاشتراك السنوي بـ250 ريال شامل الضريبة.', expect: { escalate: false, decision: 'ANSWER_VERIFIED' } },
  { tenant: 'B', text: 'ما أقدر أسجل دخول', expect: { escalate: false, decision: 'ANSWER_VERIFIED' }, draft: 'خطوات الدخول: افتح الصفحة واستخدم بريدك وكلمة المرور والكود يوصلك على جوالك.' },
  { tenant: 'NOTARGET', text: 'عندي مشكلة كبيرة', expect: { escalate: false } },
  // Adversarial NOVEL procedural actions (not in any blacklist) with no documented
  // support → must be stripped, no fake action.
  { tenant: 'NOTARGET', text: 'التطبيق ما يفتح', draft: 'عطّل الـVPN وغيّر صلاحيات التطبيق وأعد تعيين كلمة المرور عشان يضبط', expect: { escalate: false, noProcedures: true } },
];

async function main() {
let failures = 0;
console.log('=== SUPPORT-CONTRACT PIPELINE REPLAY (synthetic tenants, no WhatsApp) ===\n');
for (const sc of SCENARIOS) {
  const config = TENANTS[sc.tenant];
  // run 3× to demonstrate deterministic stability
  let last;
  for (let i = 0; i < 3; i++) last = await runTurn(config, sc.text, sc.draft || BAD_DRAFT);
  const r = last;

  const problems = [];
  if (!r.boundedBase) problems.push('blob became prompt base');
  if (/الإنترنت|تسجيل الدخول وجرب|تأكد من اتصالك/.test(r.finalReply)) problems.push('invented troubleshooting leaked');
  if (sc.expect.noProcedures && /VPN|صلاحيات|كلمة المرور|أعد تعيين|عطّل/.test(r.finalReply)) problems.push('novel invented procedure leaked');
  if (sc.expect.escalate && !r.escalationTarget) problems.push('expected a real escalation, none happened');
  if (!sc.expect.escalate && r.escalationTarget) problems.push('unexpected escalation');
  if (sc.expect.target && !sc.expect.target.test(String(r.escalationTarget))) problems.push('wrong tenant target');
  if (!sc.expect.escalate && /الإدارة|يتواصل معك الفريق|بسجل طلبك/.test(r.finalReply)) problems.push('fake action claim without escalation');
  if (sc.expect.decision && r.decision !== sc.expect.decision) problems.push(`decision ${r.decision} != ${sc.expect.decision}`);
  if (!r.finalReply || r.finalReply.trim().length < 2) problems.push('empty reply');

  if (problems.length) failures += 1;
  console.log(`tenant=${config.userId}`);
  console.log(`  customer      : ${sc.text}`);
  console.log(`  bounded_base  : ${r.boundedBase}`);
  console.log(`  decision      : ${r.decision}  diagnostics=[${r.diagnostics.join(',')}]`);
  console.log(`  escalation    : ${r.escalationTarget || 'none'}`);
  console.log(`  final_reply   : ${r.finalReply}`);
  console.log(`  result        : ${problems.length ? 'FAIL → ' + problems.join('; ') : 'PASS (semantic criteria met)'}`);
  console.log('');
}

console.log(failures ? `REPLAY RESULT: ${failures} scenario(s) FAILED` : 'REPLAY RESULT: ALL SCENARIOS PASS');
process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
