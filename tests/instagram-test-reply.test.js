'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateInstagramTestReply, buildAiConfig } = require('../src/services/instagram/instagram-test-reply');

function deps(overrides = {}) {
  const seen = {};
  class FakeAI {
    constructor(config) { seen.config = config; }
    async getReply(history, opts) { seen.history = history; seen.opts = opts; return overrides.reply ?? 'رد تجريبي'; }
  }
  return {
    seen,
    resolveInstagramConfig: async () => overrides.igSettings || { enabled: true, config: { model: 'gpt-4o', tone: 'ودّي' } },
    resolveConfigForAI: async () => overrides.keys || { openaiApiKey: 'sk-ig', model: 'fallback-model' },
    AIClient: FakeAI,
    ...overrides.extra,
  };
}

test('buildAiConfig merges IG config with resolved keys and prefers IG model', () => {
  const cfg = buildAiConfig({ model: 'claude-sonnet-5', tone: 'x' }, { openaiApiKey: 'k1', anthropicApiKey: 'k2', model: 'other' });
  assert.equal(cfg.model, 'claude-sonnet-5');   // IG model wins
  assert.equal(cfg.openaiApiKey, 'k1');
  assert.equal(cfg.anthropicApiKey, 'k2');
  assert.equal(cfg.tone, 'x');
});

test('buildAiConfig falls back to the resolved model when IG config has none', () => {
  const cfg = buildAiConfig({}, { model: 'fallback-model' });
  assert.equal(cfg.model, 'fallback-model');
});

test('generateInstagramTestReply returns the AI reply using the Instagram config + keys', async () => {
  const d = deps();
  const out = await generateInstagramTestReply('u1', [{ role: 'user', content: 'مرحبا' }], d);
  assert.equal(out.reply, 'رد تجريبي');
  assert.equal(out.model, 'gpt-4o');
  assert.equal(out.aiEnabled, true);
  assert.equal(d.seen.config.openaiApiKey, 'sk-ig');   // used IG-resolved key
  assert.equal(d.seen.config.model, 'gpt-4o');         // used IG model
});

test('generateInstagramTestReply marks isFirstMsg based on assistant turns in history', async () => {
  const d1 = deps();
  await generateInstagramTestReply('u1', [{ role: 'user', content: 'hi' }], d1);
  assert.equal(d1.seen.opts.isFirstMsg, true);

  const d2 = deps();
  await generateInstagramTestReply('u1', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'أهلاً' },
    { role: 'user', content: 'كم السعر؟' },
  ], d2);
  assert.equal(d2.seen.opts.isFirstMsg, false);
});

test('generateInstagramTestReply reports aiEnabled=false without blocking the sandbox reply', async () => {
  const d = deps({ igSettings: { enabled: false, config: { model: 'gpt-4o' } }, reply: 'رد رغم الإيقاف' });
  const out = await generateInstagramTestReply('u1', [{ role: 'user', content: 'hi' }], d);
  assert.equal(out.aiEnabled, false);
  assert.equal(out.reply, 'رد رغم الإيقاف');   // sandbox still generates
});

test('generateInstagramTestReply requires a userId', async () => {
  await assert.rejects(() => generateInstagramTestReply('  ', [], deps()), /userId required/);
});
