'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reviewFinalReplyBeforeSend, reviewReplyQuality } = require('../src/services/ai/reply-quality-gate');

function fakeOpenAIFinal(finalReply, decision = 'pass') {
  return { chat: { completions: { create: async () => ({
    choices: [{ message: { content: JSON.stringify({ decision, reason: '', repeated_claims: [], violations: [], final_reply: finalReply }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }) } } };
}

test('pre-send: flag ON + decision pass → returns ORIGINAL draft, not the paraphrase', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  process.env.REVIEW_PASSTHROUGH_ENABLED = 'true';
  try {
    const draft = 'أكيد، الاشتراك رسمي ومضمون';
    const res = await reviewFinalReplyBeforeSend({
      openai: fakeOpenAIFinal('نعم، إن الاشتراك لدينا رسمي ومكفول بالكامل'),
      model: 'gpt-4o', draft, customerText: 'الاشتراك مضمون؟',
      history: [{ role: 'assistant', content: 'هلا' }, { role: 'user', content: 'الاشتراك مضمون؟' }],
      config: {}, logger: { info(){}, warn(){} },
    });
    assert.strictEqual(res.reply, draft, 'clean pass must keep the original draft');
  } finally { if (prev === undefined) delete process.env.REVIEW_PASSTHROUGH_ENABLED; else process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});

test('pre-send: flag OFF → legacy behavior (uses reviewer final_reply)', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  delete process.env.REVIEW_PASSTHROUGH_ENABLED;
  try {
    const res = await reviewFinalReplyBeforeSend({
      openai: fakeOpenAIFinal('النسخة المُراجَعة'),
      model: 'gpt-4o', draft: 'المسودة الأصلية', customerText: 'س',
      history: [{ role: 'assistant', content: 'هلا' }, { role: 'user', content: 'س' }],
      config: {}, logger: { info(){}, warn(){} },
    });
    assert.strictEqual(res.reply, 'النسخة المُراجَعة');
  } finally { if (prev !== undefined) process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});

test('reviewReplyQuality flag ON + clean pass → keeps draft', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  process.env.REVIEW_PASSTHROUGH_ENABLED = 'true';
  try {
    const draft = 'أكيد، متوفر ونجهزه لك';
    const openai = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ decision: 'pass', intent: '', unanswered: [], violations: [], unsupported_claims: [], final_reply: 'نعم، إنه متوفر وسيتم تجهيزه' }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) } } };
    const res = await reviewReplyQuality({ openai, model: 'gpt-4o', draft, customerText: 'متوفر؟', history: [], config: {}, logger: { info(){} } });
    assert.strictEqual(res.reply, draft);
  } finally { if (prev === undefined) delete process.env.REVIEW_PASSTHROUGH_ENABLED; else process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});
