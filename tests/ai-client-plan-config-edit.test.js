'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
function clientReturning(content) {
  return { openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } }, model: 'gpt-4o' };
}
const CONFIG = { products: [{ name: 'اشتراك أدوبي', price: '80' }], autoReplyKeywords: { 'الدوام': 'x' }, doNotReplyList: [] };

test('planConfigEdit parses a product-update plan', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({
    target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99',
  }));
  const plan = await ai.planConfigEdit(CONFIG, 'غيّر سعر أدوبي إلى 99');
  assert.equal(plan.target, 'products');
  assert.equal(plan.action, 'update');
  assert.equal(plan.product.price, '99');
});

test('planConfigEdit parses a do-not-reply add and tolerates ```json fences', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning('```json\n{"target":"do_not_reply","action":"add","number":"0501234567","summary":"حظر"}\n```');
  const plan = await ai.planConfigEdit(CONFIG, 'احظر 0501234567');
  assert.equal(plan.target, 'do_not_reply');
  assert.equal(plan.number, '0501234567');
});

test('planConfigEdit returns a clarify field when the model is unsure', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({ target: 'products', action: 'update', clarify: 'أي منتج تقصد؟' }));
  const plan = await ai.planConfigEdit(CONFIG, 'غيّر السعر');
  assert.equal(plan.clarify, 'أي منتج تقصد؟');
});

test('planConfigEdit gives the model full product context (variants) so it can edit them', async () => {
  const cfg = { products: [{ name: 'اشتراك أدوبي', price: '80', variants: [{ label: 'سنة', price: '250' }, { label: '4 اشهر', price: '90' }, { label: '8 اشهر', price: '150' }] }] };
  let seenSystem = '';
  const ai = new AIClient(cfg, silentLogger);
  ai.buildClient = () => ({
    model: 'gpt-4o',
    openai: { chat: { completions: { create: async (payload) => { seenSystem = payload.messages[0].content; return { choices: [{ message: { content: JSON.stringify({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', variants: [{ label: '4 اشهر', price: '90' }, { label: '8 اشهر', price: '150' }] }, summary: 'حذف خيار السنة' }) } }] }; } } } },
  });
  const plan = await ai.planConfigEdit(cfg, 'احذف مدة السنة من ادوبي، خلّ 4 و8 اشهر فقط');
  assert.match(seenSystem, /سنة/, 'current variants are in the model context');
  assert.match(seenSystem, /8 اشهر/);
  assert.equal(plan.product.variants.length, 2, 'model returns the full new variants list');
});

test('planConfigEdit returns null on unparseable output or unknown target', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning('مالها علاقة');
  assert.equal(await ai.planConfigEdit(CONFIG, 'xx'), null);
  ai.buildClient = () => clientReturning(JSON.stringify({ target: 'unknown', action: 'add' }));
  assert.equal(await ai.planConfigEdit(CONFIG, 'xx'), null);
});
