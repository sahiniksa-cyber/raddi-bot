'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeFrequentQuestionKeys,
  userLearningEnabled,
  normalizeQuestion,
  MIN_DISTINCT_CUSTOMERS,
} = require('../src/services/learning/owner-reply-learner');

// ---- (B) frequency: only questions asked by >= MIN_DISTINCT_CUSTOMERS customers ----

test('default frequency threshold is 3 distinct customers', () => {
  assert.equal(MIN_DISTINCT_CUSTOMERS, 3);
});

test('computeFrequentQuestionKeys keeps a question asked by 3 distinct conversations, drops a one-off', async () => {
  const q = 'كم سعر التوصيل للرياض؟';   // asked by 3 different customers
  const rare = 'هل عندكم اللون البنفسجي الغامق المطفي؟'; // asked once
  const rows = [
    { conversation_id: 'c1', content: q },
    { conversation_id: 'c2', content: q },
    { conversation_id: 'c3', content: q },
    { conversation_id: 'c9', content: rare },
  ];
  const database = { isConfigured: () => true, query: async () => ({ rows }) };
  const frequent = await computeFrequentQuestionKeys({ database, userId: 'u1' });
  assert.ok(frequent.has(normalizeQuestion(q)), 'frequent question must be kept');
  assert.ok(!frequent.has(normalizeQuestion(rare)), 'one-off question must be dropped');
});

test('computeFrequentQuestionKeys counts DISTINCT conversations, not repeats by one customer', async () => {
  const q = 'متى يوصل الطلب؟';
  const rows = [
    { conversation_id: 'c1', content: q },
    { conversation_id: 'c1', content: q }, // same customer again
    { conversation_id: 'c1', content: q }, // same customer again
  ];
  const database = { isConfigured: () => true, query: async () => ({ rows }) };
  const frequent = await computeFrequentQuestionKeys({ database, userId: 'u1' });
  assert.ok(!frequent.has(normalizeQuestion(q)), 'one customer asking 3x is NOT frequent');
});

test('computeFrequentQuestionKeys ignores non-questions (statements) when counting', async () => {
  const statement = 'تمام شكرا لك يا غالي'; // not a question
  const rows = [
    { conversation_id: 'c1', content: statement },
    { conversation_id: 'c2', content: statement },
    { conversation_id: 'c3', content: statement },
  ];
  const database = { isConfigured: () => true, query: async () => ({ rows }) };
  const frequent = await computeFrequentQuestionKeys({ database, userId: 'u1' });
  assert.equal(frequent.size, 0);
});

// ---- (C) per-merchant learning on/off ----

test('userLearningEnabled defaults to true when the flag is unset', async () => {
  const database = { isConfigured: () => true, query: async () => ({ rows: [{ v: null }] }) };
  assert.equal(await userLearningEnabled({ database, userId: 'u1' }), true);
});

test('userLearningEnabled is false only when config.learningEnabled === "false"', async () => {
  const off = { isConfigured: () => true, query: async () => ({ rows: [{ v: 'false' }] }) };
  assert.equal(await userLearningEnabled({ database: off, userId: 'u1' }), false);
  const on = { isConfigured: () => true, query: async () => ({ rows: [{ v: 'true' }] }) };
  assert.equal(await userLearningEnabled({ database: on, userId: 'u1' }), true);
});

test('userLearningEnabled fails open (true) on a db error', async () => {
  const database = { isConfigured: () => true, query: async () => { throw new Error('db down'); } };
  assert.equal(await userLearningEnabled({ database, userId: 'u1' }), true);
});
