'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');

function makeClient(overrides = {}) {
  const config = {
    storeName: 'متجري',
    welcomeMessage: 'هلا والله',
    model: 'google/gemini-2.0-flash',
    googleApiKey: 'AIzaSyDummyKeyForTesting1234',
    products: [{ name: 'منتج تجريبي', price: '99 ريال', description: 'وصف' }],
    escalationContacts: [{ name: 'محمد', phone: '0500000000', role: 'مدير', when: 'مشاكل' }],
    ...overrides,
  };
  return new AIClient(
    config,
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {}, save: () => {} },
  );
}

test('buildSystemPrompt does not wrap welcomeMessage in quote marks', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([], { isFirstMsg: true });
  assert.ok(!prompt.includes('"هلا والله"'), 'welcomeMessage must not appear wrapped in double quotes');
  assert.ok(!prompt.includes("'هلا والله'"), 'welcomeMessage must not appear wrapped in single quotes');
});

test('buildSystemPrompt does not wrap storeName in quote marks', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  assert.ok(!prompt.includes('"متجري"'), 'storeName must not appear wrapped in double quotes');
});

test('buildSystemPrompt does not contain quoted example phrases for the AI to mimic', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  assert.ok(!prompt.includes('"ثانية بس"'), 'example casual phrases must not be in quote marks');
  assert.ok(!prompt.includes('"خلني أشوف"'), 'example casual phrases must not be in quote marks');
  assert.ok(!prompt.includes('"خلني أحوّلك للمختص"'), 'escalation example must not be in quote marks');
});

test('buildSystemPrompt still includes the store name and welcome message somewhere', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([], { isFirstMsg: true });
  assert.ok(prompt.includes('متجري'), 'storeName must appear in the prompt');
  assert.ok(prompt.includes('هلا والله'), 'welcomeMessage must appear in the prompt');
});

test('buildSystemPrompt has positive-phrased rules instead of the old "ممنوع" block', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /القواعد الذهبية/);
});

test('AIClient integrates stripAvoidedContent in getReply', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.match(src, /stripAvoidedContent/);
  assert.match(src, /require\(['"]\.\/post-process-reply['"]\)/);
});
