'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silent = { info() {}, warn() {}, error() {} };
function clientWithReviewer(reviewerJson, config) {
  const base = config || { replyStyle: { lineBreakMode: 'connected', emojiLevel: 'none' } };
  const ai = new AIClient(base, silent, { record() {} });
  ai.buildClient = () => ({
    model: 'test-model',
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(reviewerJson) } }], usage: {} }) } } },
  });
  return ai;
}

// Bug 1: an LLM reviewer `suppress` decision ALONE must not drop a legitimately
// new reply. Only the deterministic duplicate guard (a real double-send with no
// new customer turn) may suppress. A correct price answer to a new "كم؟" MUST be
// delivered.
test('LLM suppress is ignored when a new customer turn asked a new question → price delivered', async () => {
  const ai = clientWithReviewer(
    { decision: 'suppress', reason: 'يبدو مكرراً', repeated_claims: [], violations: [], final_reply: '' },
    { replyStyle: { lineBreakMode: 'connected', emojiLevel: 'none' }, products: [{ name: 'اشتراك أدوبي', price: 189 }], pricingRules: [{ type: 'percentage_addition', value: 10, trigger: 'تقسيط', label: 'تقسيط' }] },
  );
  const result = await ai.reviewBeforeSend({
    draft: 'السعر بعد الرسوم 207.9 ريال.',
    customerText: 'كم؟',
    history: [
      { role: 'user', content: 'أبي اشتراك أدوبي' },
      { role: 'assistant', content: 'اشتراك أدوبي بـ189 ريال. كيف تحب تدفع؟' },
      { role: 'user', content: 'تقسيط' },
      { role: 'assistant', content: 'تمام بالتقسيط.' },
      { role: 'user', content: 'كم؟' }, // NEW customer turn after the last assistant reply
    ],
  });
  assert.equal(result.suppressed, false, 'must NOT suppress a new answer');
  assert.ok(result.reply.includes('207.9'), 'the correct price must reach the customer');
});

// The genuine double-send (two assistant replies, no customer turn between, full
// repeat) MUST still be suppressed by the deterministic guard.
test('deterministic guard still suppresses a true double-send (no new customer turn)', async () => {
  const ai = clientWithReviewer({ decision: 'pass', reason: 'clean', repeated_claims: [], violations: [], final_reply: 'طلبك مسجّل وقيد المتابعة.' });
  const result = await ai.reviewBeforeSend({
    draft: 'طلبك مسجّل وقيد المتابعة.',
    customerText: 'تمام',
    history: [
      { role: 'user', content: 'وش الأخبار عن طلبي' },
      { role: 'assistant', content: 'طلبك مسجّل وقيد المتابعة.' }, // last turn is assistant → double-send shape
    ],
  });
  assert.equal(result.suppressed, true, 'a real repeat with no new customer turn is still suppressed');
});
