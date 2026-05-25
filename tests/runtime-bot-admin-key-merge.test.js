'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveConfigForAI } = require('../src/services/bot/runtime-bot');

test('resolveConfigForAI falls back to admin key when customer config is empty', async () => {
  const deps = {
    loadBotConfig: async () => ({ model: 'google/gemini-2.0-flash', openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }),
  };
  const cfg = await resolveConfigForAI('user-1', deps);
  assert.equal(cfg.openaiApiKey, 'admin-openai');
  assert.equal(cfg.googleApiKey, 'admin-google');
});

test('resolveConfigForAI keeps customer override when set', async () => {
  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-openai' }),
    loadAdminKeys: async () => ({ openai: 'admin-openai', google: '', anthropic: '', openrouter: '' }),
  };
  const cfg = await resolveConfigForAI('user-1', deps);
  assert.equal(cfg.openaiApiKey, 'customer-openai');
});
