'use strict';

// EMERGENCY — internal escalation destinations must NEVER be customer-facing.
// (1) they must not appear in the LLM prompt; (2) a deterministic pre-send guard
// must block/replace any customer reply that contains a tenant's internal
// destination, in any Saudi phone formatting variant. Synthetic numbers only.
const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const {
  reconcileSupportReply,
  containsInternalDestination,
  collectInternalDestinations,
  redactInternalDestinations,
} = require('../src/services/ai/support-contract');
const { prepareEscalation } = require('../src/workers/escalation-routing');

function client(config) {
  return new AIClient(config, { info() {}, warn() {}, error() {} });
}

// ── FIX 1 — no destination in the LLM prompt ────────────────────────────────
test('prompt: escalation contact name is present but the phone is NOT', () => {
  const sys = client({
    storeName: 'متجري',
    escalationContacts: [{ name: 'الدعم', role: 'الفريق المختص', when: 'مشاكل الخدمة', phone: '0551234567' }],
  }).buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  assert.ok(sys.includes('الدعم'), 'contact name must remain for routing');
  for (const variant of ['0551234567', '966551234567', '+966551234567', '551234567']) {
    assert.ok(!sys.includes(variant), `prompt leaked destination variant: ${variant}`);
  }
});

test('prompt: internal messageTemplate / target / jid are NOT rendered', () => {
  const sys = client({
    storeName: 'متجري',
    escalationContacts: [{ name: 'الدعم', target: '0551234567@c.us', groupJid: '123456789012345678@g.us', messageTemplate: 'اتصل على 0551234567' }],
  }).buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  assert.ok(!sys.includes('0551234567'), 'target/messageTemplate phone leaked');
  assert.ok(!sys.includes('@g.us') && !sys.includes('@c.us'), 'internal jid leaked');
});

// ── collectInternalDestinations / containsInternalDestination ───────────────
test('guard: detects the destination across Saudi formatting variants', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  for (const v of [
    'تواصل مع الدعم على 0551234567',
    'كلمهم على +966551234567',
    'واتساب 966551234567',
    'الرقم 055 123 4567',
    'اتصل +966 55 123 4567',
  ]) {
    assert.equal(containsInternalDestination(v, config), true, `missed leak in: ${v}`);
  }
});

test('guard: a DIFFERENT public number is NOT flagged (only internal destinations)', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  assert.equal(containsInternalDestination('للاستفسار اتصل بخدمة المبيعات 0509999999', config), false);
});

test('guard: no escalation contacts → nothing to protect', () => {
  assert.deepEqual(collectInternalDestinations({}), []);
  assert.equal(containsInternalDestination('اتصل 0551234567', {}), false);
});

// ── reconcile replaces a leaking reply ──────────────────────────────────────
test('reconcile: leak + real escalation → "تم رفع طلبك للفريق المختص." (no number)', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const res = reconcileSupportReply({
    reply: 'تواصل مع الدعم على 0551234567', config,
    escalationEnqueued: true, escalationPolicyMatched: false, customerText: 'اشتراكي وقف',
  });
  assert.ok(!/0551234567|966551234567/.test(res.reply), `number survived: ${res.reply}`);
  assert.match(res.reply, /تم رفع طلبك للفريق المختص/);
  assert.ok(res.diagnostics.includes('internal_destination_redacted'));
});

test('reconcile: leak + NO real escalation → "وصلتني رسالتك." (no number)', () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const res = reconcileSupportReply({
    reply: 'كلم الدعم على 966551234567', config,
    escalationEnqueued: false, escalationPolicyMatched: false, customerText: 'مشكلة',
  });
  assert.ok(!/551234567/.test(res.reply), `number survived: ${res.reply}`);
  assert.match(res.reply, /وصلتني رسالتك/);
});

// ── LEGACY botInstructions escalation phone (single source of truth) ────────
const LEGACY = { botInstructions: 'إذا ما عرفت الحل صعّد للمالك على 0551234567', escalationContacts: [] };

test('legacy: the botInstructions escalation phone is included in the guarded destinations', () => {
  assert.ok(collectInternalDestinations(LEGACY).includes('966551234567'), 'legacy fallback phone must be protected');
});

test('legacy: server-side routing still resolves the botInstructions phone', () => {
  const prepared = prepareEscalation({
    reply: 'تمام، رفعت طلبك. [تحويل:المالك|اشتراك ادوبي وقف]',
    config: LEGACY,
    customerSender: '966500000001@s.whatsapp.net',
    inboundText: 'اشتراكي في ادوبي وقف',
  });
  assert.ok(prepared.ownerMessage, 'escalation must still resolve a real destination');
  assert.equal(prepared.ownerMessage.sender, '966551234567@c.us', 'routing must dial the legacy fallback');
});

test('legacy: buildSystemPrompt (long instructions) redacts the phone but keeps context', () => {
  const long = `${'التزم بلهجة سعودية مختصرة وواضحة في كل الردود مع العملاء دائماً. '.repeat(3)}إذا ما عرفت الحل صعّد للمالك على 0551234567.`;
  const sys = client({ storeName: 'متجري', botInstructions: long, escalationContacts: [] })
    .buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  for (const v of ['0551234567', '966551234567', '+966551234567']) {
    assert.ok(!sys.includes(v), `legacy phone leaked into prompt: ${v}`);
  }
  assert.ok(sys.includes('المالك') || sys.includes('صعّد'), 'routing/context wording preserved');
});

test('legacy: redactInternalDestinations masks the phone across variants, keeps other digits', () => {
  const t = 'صعّد للمالك على 0551234567 أو +966 55 123 4567، والسعر 299 ريال';
  const out = redactInternalDestinations(t, LEGACY);
  assert.ok(!/0?551234567/.test(out.replace(/\s/g, '')), `phone survived redaction: ${out}`);
  assert.ok(/299/.test(out), 'unrelated price digits must be preserved');
});

test('legacy: a leaking reply is blocked (guard) — real escalation → handoff ack', () => {
  const res = reconcileSupportReply({
    reply: 'تواصل مع المالك على +966 55 123 4567', config: LEGACY,
    escalationEnqueued: true, escalationPolicyMatched: false, customerText: 'اشتراكي وقف',
  });
  assert.ok(!/551234567/.test(res.reply.replace(/\s/g, '')), `legacy destination leaked: ${res.reply}`);
  assert.match(res.reply, /تم رفع طلبك للفريق المختص/);
});

// ── FINAL catch-all: every composed LLM message is sanitized ────────────────
function composedText(config, history = [{ role: 'user', content: 'مرحبا' }]) {
  return client(config).composeMessages(history, {}).map(m => m.content).join('\n');
}

test('compose: destination in escalationContacts.when is redacted from ALL messages', () => {
  const config = { storeName: 'متجري', escalationContacts: [{ name: 'الدعم', phone: '0551234567', when: 'عند المشكلة كلم 0551234567' }] };
  const text = composedText(config);
  assert.ok(!/0551234567|966551234567/.test(text), `number leaked via .when: ${text.slice(0, 400)}`);
  assert.ok(text.includes('الدعم'), 'contact name still present for the model');
});

test('compose: destination in escalationConditions / storeDescription is redacted', () => {
  const config = {
    storeName: 'متجري',
    storeDescription: 'للطوارئ اتصل على 0551234567',
    escalationConditions: 'صعّد وكلمهم على 0551234567',
    escalationContacts: [{ name: 'الدعم', phone: '0551234567' }],
  };
  assert.ok(!/0551234567|966551234567/.test(composedText(config)), 'number leaked via a non-botInstructions field');
});

test('compose: a protected number in PRIOR history is redacted', () => {
  const config = { storeName: 'متجري', escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const history = [
    { role: 'user', content: 'مرحبا' },
    { role: 'assistant', content: 'تواصل مع الدعم على 0551234567' }, // the already-leaked live reply
    { role: 'user', content: 'طيب' },
  ];
  assert.ok(!/0551234567|966551234567/.test(composedText(config, history)), 'history leaked the number');
});

test('compose: a DIFFERENT public number (not a configured destination) stays visible', () => {
  const config = {
    storeName: 'متجري',
    storeDescription: 'رقم المبيعات العام 0509999999',
    escalationContacts: [{ name: 'الدعم', phone: '0551234567' }],
  };
  const text = composedText(config);
  assert.ok(text.includes('0509999999'), 'public non-destination number must remain visible');
  assert.ok(!/0551234567/.test(text), 'the internal destination is still redacted');
});

// ── raw() provider entry point (auxiliary structured calls) ─────────────────
const { buildExtractionRequest } = require('../src/services/ai/conversation-state');

function rawCapture(config) {
  const ai = client(config);
  const captured = {};
  ai.buildClient = () => ({
    model: 'test-model',
    openai: { chat: { completions: { create: async (payload) => { captured.payload = payload; return { choices: [{ message: { content: '{}' } }] }; } } } },
  });
  return { ai, captured };
}

test('raw: sanitizes every provider message; does not mutate the caller array', async () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const { ai, captured } = rawCapture(config);
  const messages = [
    { role: 'system', content: 'استخرج الحالة' },
    { role: 'user', content: 'LAST_BOT_REPLY: تواصل مع الدعم على 0551234567' },
  ];
  await ai.raw({ messages });
  const sent = captured.payload.messages.map(m => m.content).join('\n');
  assert.ok(!/0551234567|966551234567/.test(sent), `raw leaked the number: ${sent}`);
  assert.equal(messages[1].content, 'LAST_BOT_REPLY: تواصل مع الدعم على 0551234567', 'caller array must NOT be mutated');
});

test('raw: conversation-state extraction with a leaked lastBotReply sends no protected number', async () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const { ai, captured } = rawCapture(config);
  const req = buildExtractionRequest({
    previousState: {},
    newTurns: [{ role: 'user', content: 'طيب' }],
    lastBotReply: 'تواصل مع الدعم على 0551234567',
  });
  await ai.raw(req);
  const sent = captured.payload.messages.map(m => m.content).join('\n');
  assert.ok(!/0551234567|966551234567/.test(sent), `state-extraction leaked the number: ${sent}`);
});

test('raw: a different public number stays unchanged', async () => {
  const config = { escalationContacts: [{ name: 'الدعم', phone: '0551234567' }] };
  const { ai, captured } = rawCapture(config);
  await ai.raw({ messages: [{ role: 'user', content: 'رقم المبيعات 0509999999' }] });
  const sent = captured.payload.messages.map(m => m.content).join('\n');
  assert.ok(sent.includes('0509999999'), 'public number must survive raw()');
});

// ── multi-tenant isolation ──────────────────────────────────────────────────
test('guard: tenant A guard does not use tenant B destinations', () => {
  const A = { escalationContacts: [{ name: 'الدعم', phone: '0551111111' }] };
  const B = { escalationContacts: [{ name: 'الدعم', phone: '0552222222' }] };
  // A's reply mentioning B's number is NOT A's internal destination → not flagged by A
  assert.equal(containsInternalDestination('رقم 0552222222', A), false);
  assert.equal(containsInternalDestination('رقم 0552222222', B), true);
});
