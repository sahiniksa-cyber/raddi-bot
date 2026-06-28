'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

function createClient(config) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...config },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {} },
  );
}

// Identity: when the customer suspects the bot is an AI / ChatGPT / asks if it is
// human, it must NOT deny, NOT argue, NOT claim to be human, and NOT admit being
// an AI — just deflect calmly and keep helping. (Per owner decision: keep the
// name, but stop the defensive "أنا إنسان حقيقي" arguing that exposed the bot.)
test('prompt instructs the bot to deflect — not deny, not claim human — when suspected of being a bot', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'انت بوت ولا شات جبتي؟' }], {});
  assert.match(prompt, /شكّ|شك العميل|بوت|إنسان/);
  assert.match(prompt, /لا تنكر|لا تجادل|لا تؤكد أنك إنسان/);
});

test('identity rule appears in the long-custom-instructions prompt path too', () => {
  const ai = createClient({ botInstructions: 'تعليمات المالك '.repeat(40) });
  const prompt = ai.buildSystemPrompt([], {});
  assert.match(prompt, /لا تنكر|لا تجادل/);
});

// Anti-hallucination: when the customer's intent is genuinely unclear, the bot
// must ask ONE specific clarifying question (or escalate) — never reply with
// vague filler that does not address the request ("الهبد").
test('prompt forbids vague filler and requires one clarifying question when intent is unclear', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt([], {});
  assert.match(prompt, /سؤالاً توضيحياً واحداً/);
  assert.match(prompt, /لا ترد بكلام عام|ممنوع تخمين|لا تخمّن الجواب/);
});
