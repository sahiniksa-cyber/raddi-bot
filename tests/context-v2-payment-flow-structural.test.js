'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { validateState } = require('../src/services/ai/conversation-state');
const { resolvePriceComputation, deriveResolvedPricingContext } = require('../src/services/ai/deterministic-calc');

// Structural (offline) proof of the live payment failure (item 2). Generic "X" =
// تقسيط (a payment CONDITION, not a company). This proves the DETERMINISTIC input
// handed to the main model is correct end-to-end; the REAL extractor producing
// intent=payment_method_selection is proven by the LIVE harness (BLOCKED here
// without a provider key).

const CONFIG = {
  storeName: 'متجر',
  products: [{ name: 'اشتراك التصميم', price: 189 }],
  pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }],
  botInstructions: 'بعد اختيار طريقة الدفع اطلب رقم الجوال لإرسال طلب الدفع.',
};

function prompt(state, latestUserText, history) {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  try {
    return new AIClient(CONFIG, { info() {}, warn() {}, error() {} })
      .buildSystemPrompt(history, { conversationState: state, conversationStateCanInject: true, latestUserText });
  } finally { process.env.CONVERSATION_STATE_ENABLED = prev; }
}

// The product is established; the customer answered the bare payment method "تقسيط".
const stateAfterX = validateState({
  active_entities: [
    { type: 'subscription', ref: 'design', label: 'اشتراك التصميم', last_seen: '1' },
    { type: 'payment_method', ref: 'inst', label: 'تقسيط', last_seen: '3' },
  ],
  last_turn_understanding: { intent: 'payment_method_selection' },
  // merchant flow: bot should collect the phone next
  pending_expectation: { type: 'phone_number', purpose: 'إرسال طلب الدفع', related_entity: 'اشتراك التصميم' },
});

test('bare payment method turn: no escalation marker is injected, and the merchant phone-flow is represented', () => {
  const sys = prompt(stateAfterX, 'تقسيط', [
    { role: 'assistant', content: 'تمام، اشتراك التصميم. كيف تحب تدفع؟' },
    { role: 'user', content: 'تقسيط' },
  ]);
  assert.ok(!/\[تحويل:/.test(sys), 'no escalation marker injected for a payment selection');
  assert.ok(/بانتظار رد العميل/.test(sys) && /phone_number/.test(sys), 'merchant phone-flow surfaced as a pending expectation');
});

test('then "كم؟": deterministic total 207.9 is injected as a fact, no clarification, no escalation', () => {
  const history = [
    { role: 'assistant', content: 'تمام، اشتراك التصميم. كيف تحب تدفع؟' },
    { role: 'user', content: 'تقسيط' },
    { role: 'assistant', content: 'تمام بالتقسيط. عطني رقم جوالك.' },
    { role: 'user', content: 'كم؟' },
  ];
  const sys = prompt(stateAfterX, 'كم؟', history);
  assert.ok(/calculated_total=207\.9/.test(sys), 'exact total injected');
  assert.ok(!/❓/.test(sys), 'no clarifying-price question');
  assert.ok(!/\[تحويل:/.test(sys), 'no escalation');

  // and the pure calc agrees
  const res = resolvePriceComputation({ history, latestUserText: 'كم؟', config: CONFIG, resolvedContext: deriveResolvedPricingContext(stateAfterX) });
  assert.equal(res.status, 'computed');
  assert.equal(res.computation.total, 207.9);
});
