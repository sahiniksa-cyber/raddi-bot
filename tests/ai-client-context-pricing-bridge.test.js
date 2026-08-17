'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

function client(config) {
  return new AIClient(config, { info() {}, warn() {}, error() {} });
}

const CONFIG = {
  storeName: 'x',
  products: [{ name: 'اشتراك Adobe', price: 189 }],
  pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تمارا', label: 'تمارا' }],
};

// The customer NEVER typed the product name — only the bot did, and the customer
// answered the payment method with a bare word. So the regex path (customer-text
// only) CANNOT resolve the product; only the resolved context can.
const HISTORY = [
  { role: 'assistant', content: 'أهلاً، أي منتج تحب؟' },
  { role: 'user', content: 'ودّي أشترك' },
  { role: 'assistant', content: 'تمام، اشتراك Adobe. كيف تحب تدفع؟' },
  { role: 'user', content: 'تمارا' },
  { role: 'user', content: 'كم؟' },
];
const STATE = {
  active_entities: [
    { type: 'subscription', ref: 'adobe', label: 'اشتراك Adobe', last_seen: '1' },
    { type: 'payment_method', ref: 'tamara', label: 'تمارا', last_seen: '3' },
  ],
};

test('flag ON + canInject → pricing consumes resolved context and injects the exact total (regex alone cannot)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client(CONFIG).buildSystemPrompt(HISTORY, {
    conversationState: STATE,
    conversationStateCanInject: true,
    latestUserText: 'كم؟',
  });
  assert.ok(/calculated_total=207\.9/.test(sys), 'deterministic total from resolved context');
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('flag OFF → resolved context NOT consumed → no context-driven computation', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'false';
  const sys = client(CONFIG).buildSystemPrompt(HISTORY, {
    conversationState: STATE, conversationStateCanInject: true, latestUserText: 'كم؟',
  });
  assert.ok(!/calculated_total=207\.9/.test(sys), 'no context-driven computation when the flag is off');
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('canInject=false → resolved context NOT consumed (fail-soft)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client(CONFIG).buildSystemPrompt(HISTORY, {
    conversationState: STATE, conversationStateCanInject: false, latestUserText: 'كم؟',
  });
  assert.ok(!/calculated_total=207\.9/.test(sys), 'stale/failed state must not drive pricing');
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('the state block receives latestUserText → relevance beats raw value under a tight budget (§13)', () => {
  const prevFlag = process.env.CONVERSATION_STATE_ENABLED;
  const prevBudget = process.env.CONVERSATION_STATE_BLOCK_MAX_CHARS;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  process.env.CONVERSATION_STATE_BLOCK_MAX_CHARS = '520'; // tight: only a couple sections fit
  const memories = [];
  for (let i = 0; i < 6; i++) {
    memories.push({ summary: `تفصيل شحن دولي عالي القيمة رقم ${i}`, source: 'customer', confidence: 'high', related_entities: ['شحن'] });
  }
  // low value but ON-TOPIC for the latest message
  memories.push({ summary: 'العميل يريد الاشتراك السنوي تحديداً', source: 'unknown', confidence: 'low', related_entities: ['اشتراك'] });
  const sys = client(CONFIG).buildSystemPrompt(HISTORY, {
    conversationState: { salient_memories: memories },
    conversationStateCanInject: true,
    latestUserText: 'طيب الاشتراك السنوي مضمون؟',
  });
  assert.ok(sys.includes('الاشتراك السنوي تحديداً'),
    'the on-topic low-value memory survives only because latestUserText drives relevance');
  process.env.CONVERSATION_STATE_ENABLED = prevFlag;
  process.env.CONVERSATION_STATE_BLOCK_MAX_CHARS = prevBudget;
});
