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
