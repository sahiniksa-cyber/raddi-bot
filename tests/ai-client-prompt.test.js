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

test('buildSystemPrompt does not contain hardcoded behavioral rules', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  // No hardcoded "rules block" of any kind — behavior is configured from dashboard
  assert.doesNotMatch(prompt, /القواعد الذهبية/);
  assert.doesNotMatch(prompt, /🚫 ممنوع/);
  assert.doesNotMatch(prompt, /اختم بسؤال/);
  assert.doesNotMatch(prompt, /بدون علامات اقتباس/);
  assert.doesNotMatch(prompt, /لو رحبت بالعميل سابقاً/);
});

test('AIClient integrates stripAvoidedContent in getReply', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.match(src, /stripAvoidedContent/);
  assert.match(src, /require\(['"]\.\/post-process-reply['"]\)/);
});

// ── SLA breach block injection (#177, flagged) ────────────────────────
const HOUR_MS = 3600 * 1000;

test('SLA breach block is injected into the prompt only when routing is ON and a breach is computed', () => {
  const ai = makeClient({ slaPolicies: [{ amount: 12, unit: 'ساعة', source_text: 'التفعيل حتى 12 ساعة' }] });
  const since = new Date(Date.now() - 25 * HOUR_MS);
  const { computeSlaBreach } = require('../src/services/instruction-routing/sla-breach');
  const slaBreach = computeSlaBreach({ since, now: Date.now(), slaPolicies: [{ amount: 12, unit: 'ساعة' }] });

  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  try {
    process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
    const on = ai.buildSystemPrompt([], { slaBreach });
    assert.match(on, /تنبيه وقت/, 'breach block must appear when routing on + breach computed');
    assert.match(on, /انقضت/, 'breach block must instruct the window is over');

    delete process.env.INSTRUCTION_ROUTING_ENABLED;
    const off = ai.buildSystemPrompt([], { slaBreach });
    assert.doesNotMatch(off, /تنبيه وقت/, 'breach block must NOT appear when routing off');
  } finally {
    if (prev === undefined) delete process.env.INSTRUCTION_ROUTING_ENABLED;
    else process.env.INSTRUCTION_ROUTING_ENABLED = prev;
  }
});

test('no SLA breach block when the request is within the window', () => {
  const ai = makeClient({ slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  const { computeSlaBreach } = require('../src/services/instruction-routing/sla-breach');
  const slaBreach = computeSlaBreach({ since: new Date(Date.now() - 2 * HOUR_MS), now: Date.now(), slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  try {
    process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
    const prompt = ai.buildSystemPrompt([], { slaBreach });
    assert.doesNotMatch(prompt, /تنبيه وقت/);
  } finally {
    if (prev === undefined) delete process.env.INSTRUCTION_ROUTING_ENABLED;
    else process.env.INSTRUCTION_ROUTING_ENABLED = prev;
  }
});
