'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

// Helper: create a minimal RuntimeBot with a temp data dir
function makeBot(userId = 'user-load-1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-load-'));
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

// Helper: clean up temp dir
function cleanup(bot) {
  fs.rmSync(bot.__tmpDir, { recursive: true, force: true });
}

test('bot.load() merges admin keys when customer openaiApiKey is empty', async () => {
  const bot = makeBot('user-load-1');

  // Stub deps injected into load()
  const deps = {
    loadBotConfig: async () => ({ ...require('../lib/constants').DEFAULT_CONFIG, openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key-openai', google: 'admin-key-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},  // skip DB session state
  };

  await bot.load(deps);

  assert.equal(bot.config.openaiApiKey, 'admin-key-openai', 'admin key must be applied when customer key is empty');
  assert.equal(bot.config.googleApiKey, 'admin-key-google', 'admin google key must be applied when customer key is empty');

  cleanup(bot);
});

test('bot.load() keeps customer key when customer overrides admin', async () => {
  const bot = makeBot('user-load-2');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-key', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key-openai', google: 'admin-key-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  assert.equal(bot.config.openaiApiKey, 'customer-key', 'customer key must NOT be overridden by admin key');
  assert.equal(bot.config.googleApiKey, 'admin-key-google', 'admin google key applied when customer google key is empty');

  cleanup(bot);
});

test('bot.load() propagates merged config to this.ai via updateConfig', async () => {
  const bot = makeBot('user-load-3');

  // Track what updateConfig is called with
  let capturedConfig = null;
  const originalUpdateConfig = bot.ai.updateConfig.bind(bot.ai);
  bot.ai.updateConfig = (cfg) => {
    capturedConfig = cfg;
    originalUpdateConfig(cfg);
  };

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-propagated', google: '', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  assert.ok(capturedConfig, 'updateConfig must be called after load');
  assert.equal(capturedConfig.openaiApiKey, 'admin-propagated', 'merged config must be passed to ai.updateConfig');

  cleanup(bot);
});
