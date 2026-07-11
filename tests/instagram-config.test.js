'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  seedConfigFromWhatsapp,
  resolveInstagramConfig,
} = require('../src/services/instagram/instagram-config');

test('seedConfigFromWhatsapp copies bot_configs.config verbatim', () => {
  const wa = {
    storeName: 'متجري',
    replyStyle: { employeeName: 'محمد', emojiLevel: 'heavy' },
    botInstructions: 'كن ودود',
  };
  const seeded = seedConfigFromWhatsapp(wa);
  assert.strictEqual(seeded.storeName, 'متجري');
  assert.strictEqual(seeded.replyStyle.employeeName, 'محمد');
  assert.strictEqual(seeded.replyStyle.emojiLevel, 'heavy');
  assert.strictEqual(seeded.botInstructions, 'كن ودود');
});

test('seedConfigFromWhatsapp deep-clones so later edits never alias WhatsApp', () => {
  const wa = { replyStyle: { employeeName: 'محمد' } };
  const seeded = seedConfigFromWhatsapp(wa);
  seeded.replyStyle.employeeName = 'CHANGED';
  assert.strictEqual(wa.replyStyle.employeeName, 'محمد', 'WhatsApp config must be untouched');
});

test('seedConfigFromWhatsapp on empty WA config returns defaults, never throws', () => {
  const seeded = seedConfigFromWhatsapp(null);
  assert.ok(seeded && typeof seeded === 'object');
});

test('resolveInstagramConfig seeds when no IG row exists yet', async () => {
  const inserts = [];
  const database = {
    query: async (sql, params) => {
      if (sql.includes('FROM instagram_ai_settings')) return { rows: [] };
      if (sql.includes('FROM bot_configs')) return { rows: [{ config: { storeName: 'WA-Store' } }] };
      if (sql.includes('INSERT INTO instagram_ai_settings')) { inserts.push(params); return { rows: [{}] }; }
      return { rows: [] };
    },
  };
  const cfg = await resolveInstagramConfig('user-1', { database });
  assert.strictEqual(cfg.config.storeName, 'WA-Store');
  assert.strictEqual(cfg.seededFromWhatsapp, true);
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(inserts.length, 1, 'should persist the seed once');
});

test('resolveInstagramConfig returns existing IG row without reseeding', async () => {
  const database = {
    query: async (sql) => {
      if (sql.includes('FROM instagram_ai_settings')) {
        return { rows: [{ enabled: true, seeded_from_whatsapp: true, config: { storeName: 'IG-Store' } }] };
      }
      throw new Error('should not read bot_configs when IG row exists');
    },
  };
  const cfg = await resolveInstagramConfig('user-1', { database });
  assert.strictEqual(cfg.config.storeName, 'IG-Store');
  assert.strictEqual(cfg.enabled, true);
});
