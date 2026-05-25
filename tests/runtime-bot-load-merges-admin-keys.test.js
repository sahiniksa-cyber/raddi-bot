'use strict';

/**
 * NOTE: These tests were originally written to verify that bot.load() merged
 * admin keys into this.config. That contract changed in the Task 4 fix:
 *
 *   - bot.load() now keeps this.config as CUSTOMER-ONLY (no admin keys).
 *   - bot.resolveConfig() returns the merged config on demand.
 *   - bot.getAIReply() / bot.buildAIClient() call resolveConfig() internally.
 *
 * The tests below have been updated to reflect the correct contract.
 * See also: tests/runtime-bot-resolve-config.test.js for additional coverage.
 */

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

test('bot.load() keeps this.config customer-only when customer openaiApiKey is empty', async () => {
  const bot = makeBot('user-load-1');

  const deps = {
    loadBotConfig: async () => ({ ...require('../lib/constants').DEFAULT_CONFIG, openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key-openai', google: 'admin-key-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  // this.config must NOT contain admin keys — resolveConfig() handles that
  assert.equal(bot.config.openaiApiKey || '', '', 'admin key must NOT be in this.config after load()');
  assert.equal(bot.config.googleApiKey || '', '', 'admin google key must NOT be in this.config after load()');

  cleanup(bot);
});

test('bot.load() keeps customer key in this.config when customer has an override', async () => {
  const bot = makeBot('user-load-2');

  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-key', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-key-openai', google: 'admin-key-google', anthropic: '', openrouter: '' }),
    loadSessionState: async () => {},
  };

  await bot.load(deps);

  assert.equal(bot.config.openaiApiKey, 'customer-key', 'customer key must be preserved in this.config');
  assert.equal(bot.config.googleApiKey || '', '', 'admin google key must NOT be in this.config');

  cleanup(bot);
});

test('bot.load() propagates customer config to this.ai via updateConfig (not merged)', async () => {
  const bot = makeBot('user-load-3');

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
  // load() passes customer config to ai (admin keys NOT merged in)
  assert.equal(capturedConfig.openaiApiKey || '', '', 'load() must pass customer-only config to ai.updateConfig');

  cleanup(bot);
});
