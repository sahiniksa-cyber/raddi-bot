'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Production 2026-07-02: maxResponseLength=200 → a 360-token cap truncated a
// product-card reply mid-URL ("https://prostoree."). The token ceiling must
// never be small enough to cut a formatted card + full link.
test('max_tokens has an 800 floor even when maxResponseLength is small', async () => {
  process.env.REPLY_VALIDATOR_ENABLED = 'false';
  process.env.KNOWLEDGE_INJECTION_ENABLED = 'false';
  let seenMaxTokens = null;
  const ai = new AIClient({ maxResponseLength: 200 }, silentLogger);
  ai.buildClient = () => ({
    model: 'gpt-4o',
    openai: { chat: { completions: { create: async (payload) => { seenMaxTokens = payload.max_tokens; return { choices: [{ message: { content: 'رد' } }] }; } } } },
  });
  await ai.getReply([{ role: 'user', content: 'كم سعر أدوبي' }], {});
  assert.ok(seenMaxTokens >= 800, `max_tokens must be >= 800, got ${seenMaxTokens}`);
});

test('max_tokens still scales up for a large maxResponseLength (capped at 2000)', async () => {
  process.env.REPLY_VALIDATOR_ENABLED = 'false';
  process.env.KNOWLEDGE_INJECTION_ENABLED = 'false';
  let seenMaxTokens = null;
  const ai = new AIClient({ maxResponseLength: 1500 }, silentLogger);
  ai.buildClient = () => ({
    model: 'gpt-4o',
    openai: { chat: { completions: { create: async (payload) => { seenMaxTokens = payload.max_tokens; return { choices: [{ message: { content: 'رد' } }] }; } } } },
  });
  await ai.getReply([{ role: 'user', content: 'اشرح' }], {});
  assert.ok(seenMaxTokens > 800 && seenMaxTokens <= 2000, `expected scaled tokens, got ${seenMaxTokens}`);
});
