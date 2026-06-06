'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

function client(extra) {
  return new AIClient({ ...DEFAULT_CONFIG, ...extra },
    { info(){}, warn(){}, error(){} }, { record(){} });
}
const POLICIES = { 'الشحن': 'الشحن عبر سمسا خلال 2-4 أيام' };

test('default-path prompt injects policy block', () => {
  const ai = client({ storeName: 'متجر', autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /سياسات_المتجر_الجاهزة/);
  assert.match(p, /سمسا/);
});

test('long-instructions path also injects policy block', () => {
  const ai = client({ botInstructions: 'تعليمات طويلة '.repeat(20), autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /سياسات_المتجر_الجاهزة/);
});

test('flag KNOWLEDGE_INJECTION_ENABLED=false disables injection', () => {
  process.env.KNOWLEDGE_INJECTION_ENABLED = 'false';
  const ai = client({ storeName: 'متجر', autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.doesNotMatch(p, /سياسات_المتجر_الجاهزة/);
  delete process.env.KNOWLEDGE_INJECTION_ENABLED;
});

test('getReply applies deterministic escalation tag via validator', async () => {
  const ai = client({
    storeName: 'متجر',
    escalationContacts: [{ name: 'المالك', phone: '0500000000' }],
  });
  // بدّل buildClient لإرجاع رد ثابت بدون شبكة
  ai.buildClient = () => ({
    model: 'test-model',
    openai: { chat: { completions: { create: async () => ({
      choices: [{ message: { content: 'تمام بسجل طلبك.' } }], usage: {},
    }) } } },
  });
  const out = await ai.getReply([{ role: 'user', content: 'أبي أكلم المدير' }], { isFirstMsg: true });
  assert.match(out, /\[تحويل:/);
});

test('policy block carries explicit no-invention warning for product specs (ث1 guard)', () => {
  const ai = client({ storeName: 'متجر', autoReplyKeywords: { 'الشحن': 'سمسا 2-4 أيام' } });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /مواصفات المنتجات وتوافقها[\s\S]*عدم الاختراع/);
});

test('buildSystemPrompt adds no-repeat instruction when instantAnswered provided', () => {
  const ai = client({ storeName: 'متجر' });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'بكم ادوبي؟' }], { instantAnswered: 'وعليكم السلام، حياك الله' });
  assert.match(p, /مُجاب عليه|أُجيب|سبق الرد/);
  assert.match(p, /وعليكم السلام، حياك الله/);
});
