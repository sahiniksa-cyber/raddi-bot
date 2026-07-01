'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigController } = require('../src/controllers/config.controller');

// ROOT CAUSE (production 2026-07-01): a WhatsApp prompt-edit persists the new
// botInstructions to bot_configs, but the dashboard's getConfig returned the
// WEB process's STALE in-memory bot.config — so the merchant saw no change and
// the test-chat used old instructions, even though the edit was saved and the
// AI worker (fresh DB read) already applied it. getConfig must refresh from the
// persisted store.
test('getConfig refreshes the in-memory bot config from persisted storage (out-of-band edits show up)', async () => {
  const bot = { config: { botInstructions: 'OLD', model: 'x' }, ai: { updateConfig(c) { this.updated = c; } } };
  const controller = createConfigController({
    getUserBot: () => bot,
    loadPersistedConfig: async () => ({ botInstructions: 'NEW من تعديل واتساب', model: 'x' }),
  });
  let sent;
  await controller.getConfig({ session: { userId: 'u1' } }, { json: (v) => { sent = v; } });
  assert.equal(sent.botInstructions, 'NEW من تعديل واتساب', 'dashboard shows the persisted edit');
  assert.equal(bot.config.botInstructions, 'NEW من تعديل واتساب', 'in-memory bot refreshed (test-chat sees it)');
  assert.equal(bot.ai.updated.botInstructions, 'NEW من تعديل واتساب', 'AI client updated too');
});

test('getConfig falls back to the in-memory config when the fresh read fails', async () => {
  const bot = { config: { botInstructions: 'MEM' }, ai: { updateConfig() {} } };
  const controller = createConfigController({
    getUserBot: () => bot,
    loadPersistedConfig: async () => { throw new Error('db down'); },
  });
  let sent;
  await controller.getConfig({ session: { userId: 'u1' } }, { json: (v) => { sent = v; } });
  assert.equal(sent.botInstructions, 'MEM', 'still returns something usable on read failure');
});

test('getConfig still strips API keys after refreshing', async () => {
  const bot = { config: { openaiApiKey: 'sk-should-not-leak' }, ai: { updateConfig() {} } };
  const controller = createConfigController({
    getUserBot: () => bot,
    loadPersistedConfig: async () => ({ botInstructions: 'x', openaiApiKey: 'sk-also-not' }),
  });
  let sent;
  await controller.getConfig({ session: { userId: 'u1' } }, { json: (v) => { sent = v; } });
  assert.equal(sent.openaiApiKey, undefined, 'keys never leak to the dashboard');
});
