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

test('proposePromptEdit throws a clear error when the model returns no usable output', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning('عذراً لم أفهم');
  await assert.rejects(() => ai.proposePromptEdit('قديم', 'xx'), /لم أفهم التعديل|prompt edit/i);
});

// ROOT CAUSE (production 2026-07-01): the JSON contract fails when the model
// embeds the full MULTI-LINE instructions as a JSON string value — real
// newlines make the JSON invalid, so parsing throws every time ("ما فهمت").
// The delimiter protocol must handle arbitrary multi-line Arabic content.
test('proposePromptEdit parses the delimiter format with multi-line instructions', async () => {
  const ai = new AIClient({}, silentLogger);
  const modelOut = [
    'إضافة: سياسة ضمان اشتراك أدوبي 4 أشهر.',
    '@@@INSTRUCTIONS@@@',
    'أنت موظف خدمة عملاء لمتجر ProStoree.',
    'ساعات العمل ٩ص - ٩م.',
    '',
    'لو سأل العميل عن اشتراك أدوبي 4 أشهر هل هو مضمون:',
    'قل: نعم مضمون، الاشتراك ما يكون على تيم ويبان تاريخه فوق كذا، وأكبر دليل آراء عملائنا.',
  ].join('\n');
  ai.buildClient = () => clientReturning(modelOut);
  const out = await ai.proposePromptEdit('أنت موظف خدمة عملاء لمتجر ProStoree.\nساعات العمل ٩ص - ٩م.', 'ضيف ضمان أدوبي');
  assert.match(out.summary, /ضمان اشتراك أدوبي/);
  assert.match(out.newInstructions, /نعم مضمون/);
  assert.match(out.newInstructions, /ساعات العمل/); // preserved
  assert.ok(out.newInstructions.includes('\n'), 'multi-line instructions preserved intact');
});

test('proposePromptEdit still accepts a clean JSON reply (backward-compatible fallback)', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({ newInstructions: 'ن', summary: 'س' }));
  const out = await ai.proposePromptEdit('قديم', 'غيّر');
  assert.equal(out.newInstructions, 'ن');
  assert.equal(out.summary, 'س');
});
