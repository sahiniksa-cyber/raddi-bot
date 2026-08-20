'use strict';

// Blocker 2 (part 2) — the Customer-Service Contract is also applied as a FINAL
// deterministic net at the pre-send boundary, so anything the pre-send REVIEW
// regenerated (a fake handoff claim / invented troubleshooting) is caught even
// after the ai-worker's contract pass. Behavior is proven directly on the
// exported applyPreSendContract helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Avoid pulling a live redis/db connection when requiring the worker module.
process.env.DATABASE_URL = process.env.DATABASE_URL || '';
process.env.REDIS_URL = process.env.REDIS_URL || '';

const { applyPreSendContract } = require(path.resolve(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'));

function reset() { delete process.env.SUPPORT_CONTRACT_ENABLED; }

test('pre-send net: a fake handoff claim WITH no real escalation is stripped', () => {
  reset();
  const out = applyPreSendContract('بأرفع الموضوع للإدارة ويتواصل معك الفريق قريباً', {
    config: {},
    escalationEnqueued: false,
    customerText: 'عندي مشكلة',
  });
  assert.doesNotMatch(out, /الإدارة|يتواصل معك الفريق/, `fake claim survived pre-send: ${out}`);
  assert.ok(out.trim().length >= 2);
});

test('pre-send net: invented troubleshooting the tenant never documented is stripped', () => {
  reset();
  const out = applyPreSendContract('تأكد من اتصالك بالإنترنت وجرب تسجيل الدخول', {
    config: {},
    escalationEnqueued: false,
    customerText: 'التطبيق ما يفتح',
  });
  assert.doesNotMatch(out, /الإنترنت/, `ungrounded troubleshooting survived pre-send: ${out}`);
});

test('pre-send net: a real escalation (handoffAcknowledgement) keeps a truthful handoff line', () => {
  reset();
  const reply = 'تمام، تم رفع طلبك للفريق المختص.';
  const out = applyPreSendContract(reply, { config: {}, escalationEnqueued: true, customerText: 'عندي مشكلة' });
  assert.equal(out, reply, 'a truthful handoff must not be stripped when escalation really happened');
});

test('pre-send net: clean verified answer passes through unchanged', () => {
  reset();
  const reply = 'الاشتراك السنوي بـ250 ريال ويشمل كل المزايا';
  const out = applyPreSendContract(reply, {
    config: { products: [{ name: 'اشتراك سنوي', price: '250 ريال' }] },
    escalationEnqueued: false,
    customerText: 'كم الاشتراك؟',
  });
  assert.equal(out, reply);
});

test('Blocker 1: pre-send contract is FAIL-CLOSED — a thrown reconcile never ships the unsafe draft', () => {
  reset();
  // Force reconcileSupportReply to throw AFTER a (simulated) adversarial pre-send
  // rewrite reintroduced an unsafe procedure: a config whose field access throws
  // makes the grounding step throw mid-reconcile.
  const evilConfig = {};
  Object.defineProperty(evilConfig, 'botInstructions', { get() { throw new Error('boom'); }, enumerable: true });
  const unsafe = 'عطّل الـVPN وأعد تشغيل الجهاز عشان يضبط';
  const out = applyPreSendContract(unsafe, { config: evilConfig, escalationEnqueued: false, customerText: 'مشكلة' });
  assert.notEqual(out, unsafe, 'the unsafe draft must NOT be returned on contract failure');
  assert.doesNotMatch(out, /VPN|أعد تشغيل/, `unsafe procedure reached the customer on failure: ${out}`);
  assert.ok(out.trim().length >= 2, 'fail-closed produces a safe non-empty neutral ack');
});

test('pre-send net: kill-switch =false → passthrough (rollback)', () => {
  process.env.SUPPORT_CONTRACT_ENABLED = 'false';
  try {
    const reply = 'بأرفع الموضوع للإدارة';
    assert.equal(applyPreSendContract(reply, { config: {}, escalationEnqueued: false, customerText: 'x' }), reply);
  } finally { delete process.env.SUPPORT_CONTRACT_ENABLED; }
});
