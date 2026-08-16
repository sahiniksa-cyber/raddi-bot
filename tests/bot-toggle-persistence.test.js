'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigController, mergeConfigForSave } = require('../src/controllers/config.controller');

// ROOT CAUSE (production): the bot run-state field `autoReplyEnabled` is owned by
// a DEDICATED endpoint (/api/bot/auto-reply). But the dashboard's general
// settings save (saveConf) posts a full config object that carries a STALE
// autoReplyEnabled (the in-page `config` is not refreshed when the toggle is
// used), and the backend merge let the incoming value overwrite the fresh one —
// so saving an UNRELATED setting flipped the bot OFF.
//
// Rule enforced at the persistence boundary: a general config save must NEVER
// change the bot run-state; only the dedicated endpoint may.

test('P3: general save keeps autoReplyEnabled=true even when incoming carries a stale false', () => {
  const merged = mergeConfigForSave({
    existing: { autoReplyEnabled: true, storeName: 'A' },
    incoming: { autoReplyEnabled: false, storeName: 'A-edited' }, // stale toggle + a real edit
    isAdmin: false,
  });
  assert.equal(merged.autoReplyEnabled, true, 'run-state preserved (dedicated endpoint owns it)');
  assert.equal(merged.storeName, 'A-edited', 'the real, unrelated edit still applies');
});

test('P3: general save keeps autoReplyEnabled=false even when incoming carries a stale true', () => {
  const merged = mergeConfigForSave({
    existing: { autoReplyEnabled: false, storeName: 'A' },
    incoming: { autoReplyEnabled: true, welcomeMessage: 'هلا' },
    isAdmin: false,
  });
  assert.equal(merged.autoReplyEnabled, false, 'OFF stays OFF through an unrelated save');
  assert.equal(merged.welcomeMessage, 'هلا');
});

test('P3: general save does not fabricate a run-state when none existed (defaults stay untouched)', () => {
  const merged = mergeConfigForSave({
    existing: { storeName: 'A' },
    incoming: { autoReplyEnabled: false, storeName: 'A2' },
    isAdmin: false,
  });
  assert.equal(merged.autoReplyEnabled, undefined, 'no run-state written by a general save');
  assert.equal(merged.storeName, 'A2');
});

test('P3: unrelated settings still merge normally (partial update preserved)', () => {
  const merged = mergeConfigForSave({
    existing: { autoReplyEnabled: true, storeName: 'A', model: 'gpt-4o' },
    incoming: { welcomeMessage: 'أهلاً' },
    isAdmin: false,
  });
  assert.equal(merged.autoReplyEnabled, true);
  assert.equal(merged.storeName, 'A');
  assert.equal(merged.model, 'gpt-4o');
  assert.equal(merged.welcomeMessage, 'أهلاً');
});

// Behavioral sequence through the actual controller: ON -> edit unrelated -> Save -> still ON.
function makeBot(config) {
  return { config, saved: 0, saveConfig() { this.saved += 1; this.persisted = this.config; } };
}

test('P3: ON -> save unrelated setting -> still ON (controller, single tenant)', () => {
  const bot = makeBot({ autoReplyEnabled: true, storeName: 'A' });
  const controller = createConfigController({ getUserBot: () => bot });
  // simulate the dashboard sending a full config with a STALE false + a real edit
  controller.saveConfig(
    { session: { userId: 'u1' }, body: { autoReplyEnabled: false, storeName: 'A', welcomeMessage: 'جديد' } },
    { json() {}, status() { return { json() {} }; } },
  );
  assert.equal(bot.config.autoReplyEnabled, true, 'bot stays ON after saving an unrelated setting');
  assert.equal(bot.config.welcomeMessage, 'جديد');
});

// Multi-tenant: saving tenant A must not affect tenant B (and vice versa).
test('P3: multi-tenant — saving Store A (ON) does not change Store B (OFF)', () => {
  const bots = {
    A: makeBot({ autoReplyEnabled: true, storeName: 'A' }),
    B: makeBot({ autoReplyEnabled: false, storeName: 'B' }),
  };
  const controller = createConfigController({ getUserBot: (uid) => bots[uid] });

  controller.saveConfig(
    { session: { userId: 'A' }, body: { autoReplyEnabled: false, storeName: 'A', maxResponseLength: 400 } },
    { json() {}, status() { return { json() {} }; } },
  );

  assert.equal(bots.A.config.autoReplyEnabled, true, 'Store A stays ON');
  assert.equal(bots.A.config.maxResponseLength, 400, 'Store A unrelated edit applied');
  assert.equal(bots.B.config.autoReplyEnabled, false, 'Store B untouched (still OFF)');
  assert.equal(bots.B.config.storeName, 'B', 'Store B config not leaked into by A');
});
