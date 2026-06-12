'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { rephraseTeamAnswerWithAI } = require('../src/services/escalation/escalation-bridge');
const { botSignalsTransfer } = require('../src/services/ai/reply-validator');
const { recentCustomerContext } = require('../src/workers/ai-worker');

// ── Root 1 (THE production crash, persisted in raw_payload on 2026-06-12):
// "Cannot read properties of undefined (reading 'record')" — AIClient was
// constructed without a costTracker, so every rephrase died instantly and the
// team text shipped verbatim ("قولهم يعطوني ايميلهم" reached the customer).

test('rephrase constructs AIClient with a working costTracker (reproduces the production TypeError)', async () => {
  let captured = null;
  class FakeAIClient {
    constructor(config, logger, costTracker) {
      captured = { config, logger, costTracker };
    }
    async getReply() {
      // The exact production call pattern that crashed:
      captured.costTracker.record('gpt-4o', 100, 50);
      return 'ممكن تزودنا بإيميلك عشان نخدمك؟ 🌹';
    }
  }
  const reply = await rephraseTeamAnswerWithAI({
    userId: 'u1',
    teamAnswer: 'قولهم يعطوني الايميل',
    deps: {
      AIClient: FakeAIClient,
      resolveConfig: async () => ({ model: 'gpt-4o' }),
      database: { isConfigured: () => true, query: async () => ({ rows: [] }) },
    },
  });
  assert.equal(reply, 'ممكن تزودنا بإيميلك عشان نخدمك؟ 🌹');
  assert.ok(captured.costTracker, 'costTracker must be passed');
  assert.equal(typeof captured.costTracker.record, 'function', 'record must be callable');
});

test('ai-client itself never crashes when a caller forgets the costTracker (defense in depth)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.ok(!/this\.costTracker\.record\(/.test(src), 'unguarded costTracker.record must not exist');
  assert.match(src, /this\.costTracker\?\.record\?\.\(/, 'must use optional chaining');
});

// ── Root 2 (production 2026-06-12 ~16:10): customer reported the Canva
// problem, the bot promised "بنحل لك المشكلة" — and no escalation fired until
// the customer pushed with "طيب وش الحل ؟".

test('a promise-to-fix fires the escalation at problem time', () => {
  assert.equal(botSignalsTransfer('ما يهون علينا زعلك، بنحل لك المشكلة وتبشر بالعوض إن شاء الله'), true);
  assert.equal(botSignalsTransfer('لا تشيل هم، راح نحل مشكلتك اليوم'), true);
});

test('promise-to-fix detection does not false-fire', () => {
  assert.equal(botSignalsTransfer('تقدر تحل المشكلة بنفسك من الإعدادات'), false, 'telling the CUSTOMER how to fix');
  assert.equal(botSignalsTransfer('سعر الاشتراك 59 ريال'), false);
});

// ── Root 3 (production 2026-06-12 16:13): the group escalation carried only
// the trigger ("طيب وش الحل ؟") — the actual problem was lost.

test('recentCustomerContext joins the last customer turns so the group sees the PROBLEM', () => {
  const history = [
    { role: 'user', content: 'السلام عليكم' },
    { role: 'assistant', content: 'وعليكم السلام' },
    { role: 'user', content: 'عندي مشكلة في كانفا البرو ما يفتح' },
    { role: 'assistant', content: 'بنحل لك المشكلة' },
    { role: 'user', content: 'طيب وش الحل ؟' },
  ];
  const ctx = recentCustomerContext(history, 'طيب وش الحل ؟');
  assert.match(ctx, /مشكلة في كانفا/, 'the problem statement must be included');
  assert.match(ctx, /طيب وش الحل/, 'the trigger stays too');
});

test('recentCustomerContext falls back to the current text when history is empty', () => {
  assert.equal(recentCustomerContext([], 'نص حالي'), 'نص حالي');
});

test('ai-worker passes the recent customer context to prepareEscalation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  assert.match(src, /inboundText: recentCustomerContext\(history, text\)/);
});
