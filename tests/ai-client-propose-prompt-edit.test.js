'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function clientReturning(content) {
  return {
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } },
    model: 'gpt-4o',
  };
}

test('proposePromptEdit parses a JSON object reply into {newInstructions, summary}', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({
    newInstructions: 'التعليمات الكاملة بعد الدمج',
    summary: 'إضافة: التوصيل مجاني للرياض',
  }));
  const out = await ai.proposePromptEdit('التعليمات القديمة', 'أضف إننا نوصل للرياض مجاناً');
  assert.equal(out.newInstructions, 'التعليمات الكاملة بعد الدمج');
  assert.equal(out.summary, 'إضافة: التوصيل مجاني للرياض');
});

test('proposePromptEdit tolerates JSON wrapped in ```json fences', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning('```json\n{"newInstructions":"ن","summary":"س"}\n```');
  const out = await ai.proposePromptEdit('قديم', 'غيّر شيء');
  assert.equal(out.newInstructions, 'ن');
  assert.equal(out.summary, 'س');
});

test('proposePromptEdit throws a clear error when the model returns no usable JSON', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning('عذراً لم أفهم');
  await assert.rejects(() => ai.proposePromptEdit('قديم', 'xx'), /لم أفهم التعديل|prompt edit/i);
});
