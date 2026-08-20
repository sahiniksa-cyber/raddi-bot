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
} = require('../src/services/ai/support-contract');

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

// ── multi-tenant isolation ──────────────────────────────────────────────────
test('guard: tenant A guard does not use tenant B destinations', () => {
  const A = { escalationContacts: [{ name: 'الدعم', phone: '0551111111' }] };
  const B = { escalationContacts: [{ name: 'الدعم', phone: '0552222222' }] };
  // A's reply mentioning B's number is NOT A's internal destination → not flagged by A
  assert.equal(containsInternalDestination('رقم 0552222222', A), false);
  assert.equal(containsInternalDestination('رقم 0552222222', B), true);
});
