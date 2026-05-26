'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

// Helper: create a minimal RuntimeBot with a temp data dir
function makeBot(userId = 'user-resolve-1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-resolve-'));
  const bot = new RuntimeBot(userId, {
    dataDir: tmp,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      all: () => [],
      log: () => {},
    },
  });
  bot.__tmpDir = tmp;
  return bot;
}

function cleanup(bot) {
  fs.rmSync(bot.__tmpDir, { recursive: true, force: true });
}

// ── load() contract: this.config must be customer-only ────────────────────────

test('bot.load() sets this.config to customer config WITHOUT admin keys merged in', async () => {
  const bot = makeBot('user-resolve-1');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-secret', google: 'admin-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  // this.config must NOT contain admin keys
  assert.equal(bot.config.openaiApiKey || '', '', 'admin key must NOT be merged into this.config');
  assert.equal(bot.config.googleApiKey || '', '', 'admin google key must NOT be merged into this.config');

  cleanup(bot);
});

test('bot.load() keeps customer key in this.config when customer has an override', async () => {
  const bot = makeBot('user-resolve-2');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-key', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key', google: 'admin-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  // Customer key must be preserved; admin key must NOT be applied
  assert.equal(bot.config.openaiApiKey, 'customer-key', 'customer key must be preserved in this.config');
  assert.equal(bot.config.googleApiKey || '', '', 'admin google key must NOT leak into this.config');

  cleanup(bot);
});

// ── resolveConfig() contract: returns merged config on demand ─────────────────

test('bot.resolveConfig() returns merged config with admin keys filled in', async () => {
  const bot = makeBot('user-resolve-3');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-secret', google: 'admin-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  const merged = await bot.resolveConfig();

  assert.equal(merged.openaiApiKey, 'admin-secret', 'resolveConfig must fill in admin key when customer key is empty');
  assert.equal(merged.googleApiKey, 'admin-google', 'resolveConfig must fill in admin google key when customer key is empty');

  // And this.config must still be customer-only (not modified by resolveConfig)
  assert.equal(bot.config.openaiApiKey || '', '', 'this.config must remain customer-only after resolveConfig()');

  cleanup(bot);
});

test('bot.resolveConfig() respects customer override over admin key', async () => {
  const bot = makeBot('user-resolve-4');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-key', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key', google: 'admin-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  const merged = await bot.resolveConfig();

  assert.equal(merged.openaiApiKey, 'customer-key', 'customer key must win in resolveConfig');
  assert.equal(merged.googleApiKey, 'admin-google', 'admin google key must be applied when customer has none');

  cleanup(bot);
});

// ── saveConfig regression: admin keys must NOT be persisted ──────────────────

test('saveConfig does not persist admin keys into customer bot_configs', async () => {
  const bot = makeBot('user-resolve-5');

  let savedPayload = null;
  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-secret', google: '', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
    saveBotConfig: async (userId, payload) => { savedPayload = payload; },
  };

  await bot.load(deps);
  await bot.saveConfig();

  assert.ok(savedPayload !== null, 'saveBotConfig must have been called');
  assert.equal(savedPayload.openaiApiKey || '', '', 'admin key must NOT be persisted into customer config');

  cleanup(bot);
});

test('saveConfig persists customer key when customer has an override', async () => {
  const bot = makeBot('user-resolve-6');

  let savedPayload = null;
  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-key' }),
    loadAdminKeys: async () => ({ openai: 'admin-secret', google: '', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
    saveBotConfig: async (userId, payload) => { savedPayload = payload; },
  };

  await bot.load(deps);
  await bot.saveConfig();

  assert.ok(savedPayload !== null, 'saveBotConfig must have been called');
  assert.equal(savedPayload.openaiApiKey, 'customer-key', 'customer key must be persisted correctly');

  cleanup(bot);
});

// ── getAIReply() uses merged config internally ────────────────────────────────

test('getAIReply calls this.ai.updateConfig with merged config before replying', async () => {
  const bot = makeBot('user-resolve-7');

  const capturedConfigs = [];
  const originalUpdateConfig = bot.ai.updateConfig.bind(bot.ai);
  bot.ai.updateConfig = (cfg) => {
    capturedConfigs.push(cfg);
    originalUpdateConfig(cfg);
  };

  // Stub getReply to avoid real AI call
  bot.ai.getReply = async () => 'ok';

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key-for-reply', google: '', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  // Reset captured configs after load to only track getAIReply call
  capturedConfigs.length = 0;

  await bot.getAIReply([], {});

  assert.ok(capturedConfigs.length > 0, 'updateConfig must be called during getAIReply');
  const lastConfig = capturedConfigs[capturedConfigs.length - 1];
  assert.equal(lastConfig.openaiApiKey, 'admin-key-for-reply', 'getAIReply must pass merged config (with admin key) to updateConfig');

  cleanup(bot);
});
