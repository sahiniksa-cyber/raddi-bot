'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateState, reconcileSystemState, buildConversationStateBlock, isSemanticDuplicate,
} = require('../src/services/ai/conversation-state');

// These prove the SAME generic engine handles any vertical. The extractor's
// per-vertical output is simulated; the engine code contains no vertical logic.

test('Tenant A (e-commerce): "ما وصل" then "خلاص وصل" → shipment resolved, not re-suggested', () => {
  const extracted = validateState({
    open_issues: [],
    resolved_issues: [{ id: 'i1', summary: 'الطلب ما وصل', resolved_by: 'customer_confirmed' }],
    active_topic: 'الشحن',
  });
  const block = buildConversationStateBlock(extracted, { canInject: true });
  assert.ok(block.includes('الطلب ما وصل'));
  assert.ok(/لا تقترحها|تأكّد حلّها/.test(block)); // instructs: do not re-suggest tracking
});

test('Tenant B (bookings): reschedule stays open — LLM cannot stamp it done', () => {
  const out = reconcileSystemState({
    open_issues: [{ id: 'b1', summary: 'تغيير الموعد', status: 'open' }],
    actions_attempted: [{ action: 'reschedule', outcome: 'worked', confirmed_by: 'system' }],
    resolved_issues: [],
  }, { escalationPending: true });
  assert.equal(out.open_issues[0].summary, 'تغيير الموعد');
  assert.equal(out.actions_attempted[0].confirmed_by, null); // no real tool → not system-confirmed
  assert.equal(out.system.escalationPending, true);
});

test('Tenant C (software): issue A resolved, issue B newly open — both tracked', () => {
  const s = validateState({
    resolved_issues: [{ id: 'c1', summary: 'البرنامج ما يشتغل', resolved_by: 'customer_confirmed' }],
    open_issues: [{ id: 'c2', summary: 'الترخيص غير ظاهر', status: 'open' }],
  });
  assert.equal(s.resolved_issues.length, 1);
  assert.equal(s.open_issues.length, 1);
  const block = buildConversationStateBlock(s, { canInject: true });
  assert.ok(block.includes('البرنامج ما يشتغل') && block.includes('الترخيص غير ظاهر'));
});

test('Tenant D (payments): no compatible method captured generically in known_facts (no wallet names hardcoded)', () => {
  const s = validateState({
    known_facts: { customer_payment_method: 'محفظة غير مدعومة', payment_compatibility: 'none' },
    open_issues: [{ id: 'd1', summary: 'طريقة دفع متوافقة', status: 'open' }],
  });
  assert.equal(s.known_facts.payment_compatibility, 'none');
  const block = buildConversationStateBlock(s, { canInject: true });
  assert.ok(block.includes('payment_compatibility'));
});

test('ProStore regression: login confirmed → not re-suggested; semantic repeat suppressed', () => {
  const s = validateState({
    resolved_issues: [{ id: 'p1', summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }],
  });
  assert.ok(buildConversationStateBlock(s, { canInject: true }).includes('تسجيل الدخول'));
  assert.equal(isSemanticDuplicate({
    candidateIntent: 'ask_login_again', recentReplyIntents: ['ask_login_again'],
    hasNewCustomerTurnSinceLastAssistant: false,
  }), true);
});
