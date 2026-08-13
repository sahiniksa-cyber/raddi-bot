'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

function client() {
  return new AIClient(
    { storeName: 'x', botInstructions: 'انت موظف خدمة عملاء محترف لمتجر عام. جاوب باختصار وبأدب واحترافية.' },
    { info() {}, warn() {}, error() {} },
  );
}

test('flag OFF → no state block (legacy prompt)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'false';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'دخول', resolved_by: 'customer_confirmed' }] },
    conversationStateCanInject: true,
  });
  assert.ok(!sys.includes('حالة المحادثة'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('flag ON + canInject → state block present', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }], open_issues: [], known_facts: {} },
    conversationStateCanInject: true,
  });
  assert.ok(sys.includes('حالة المحادثة'));
  assert.ok(sys.includes('تسجيل الدخول'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});

test('flag ON but canInject=false → no block (fail-soft)', () => {
  const prev = process.env.CONVERSATION_STATE_ENABLED;
  process.env.CONVERSATION_STATE_ENABLED = 'true';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {
    conversationState: { resolved_issues: [{ summary: 'x', resolved_by: 'customer_confirmed' }] },
    conversationStateCanInject: false,
  });
  assert.ok(!sys.includes('حالة المحادثة'));
  process.env.CONVERSATION_STATE_ENABLED = prev;
});
