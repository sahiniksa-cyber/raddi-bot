'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectInstantReplies } = require('../src/services/bot/platform-features');
const AIClient = require('../lib/ai-client');

const CFG = { autoReplyKeywords: { 'السلام عليكم': 'وعليكم السلام' } };

// ── #A (deterministic): a greeting must never SUPPRESS the customer's content.
// Only a PURE greeting takes the canned-only fast path; anything beyond the
// greeting routes to the AI (combine mode) so the questions get answered.

test('pure greeting → canned-only fast path (hasExtraQuestion false)', () => {
  const r = collectInstantReplies(CFG, 'السلام عليكم');
  assert.equal(r.matched.length, 1);
  assert.equal(r.hasExtraQuestion, false);
});

test('greeting + a request without ؟ → routes to AI', () => {
  const r = collectInstantReplies(CFG, 'السلام عليكم ودي اطلب');
  assert.equal(r.hasExtraQuestion, true);
});

test('greeting + multiple questions → routes to AI', () => {
  const r = collectInstantReplies(CFG, 'السلام عليكم كيف افعل المنتج وهل يحتاج ايميل جديد');
  assert.equal(r.hasExtraQuestion, true);
});

test('a short greeting keyword still keeps a PURE greeting on the fast path', () => {
  const r = collectInstantReplies({ autoReplyKeywords: { 'سلام': 'وعليكم السلام' } }, 'سلام عليكم');
  assert.equal(r.hasExtraQuestion, false, 'greeting fragments must not be mistaken for content');
});

// ── #B (prompt): the AI is explicitly told to answer EVERY question and not
// stop at the greeting.
test('the system prompt instructs the AI to answer all questions, not just the greeting', () => {
  const ai = new AIClient(
    { storeName: 'م', model: 'gpt-4o', openaiApiKey: 'sk-' + 'x'.repeat(40) },
    { info() {}, warn() {}, error() {} }, { record() {}, save() {} },
  );
  const prompt = ai.buildSystemPrompt([], { latestUserText: 'السلام عليكم كم السعر ومتى التوصيل؟' });
  assert.match(prompt, /كل الأسئلة|جميع الأسئلة/, 'prompt must require answering all questions');
  assert.match(prompt, /تحية|التحية/, 'prompt must address the greeting-only failure mode');
});
