'use strict';

/**
 * Instagram AI settings store (the Instagram "brain"). Kept in its own table
 * `instagram_ai_settings`, completely separate from `bot_configs` (WhatsApp),
 * so editing Instagram behaviour never affects WhatsApp.
 *
 * Requirement #3 (seeding): the first time a merchant opens the Instagram
 * settings page, we COPY their WhatsApp config into the Instagram config so
 * they start from a filled form and only tweak — never from scratch. The copy
 * is a deep clone, so later edits never alias the WhatsApp object.
 *
 * The config shape is the SAME as WhatsApp (reuses DEFAULT_CONFIG), which lets
 * the dashboard clone the WhatsApp settings form field-for-field.
 */

const db = require('../../db/client');
const { DEFAULT_CONFIG } = require('../../../lib/constants');

function seedConfigFromWhatsapp(waConfig) {
  const base = { ...DEFAULT_CONFIG, ...(waConfig || {}) };
  // Deep clone so subsequent Instagram edits can never mutate the WhatsApp config.
  return JSON.parse(JSON.stringify(base));
}

async function resolveInstagramConfig(userId, deps = {}) {
  const database = deps.database || db;
  const existing = await database.query(
    'SELECT enabled, seeded_from_whatsapp, config FROM instagram_ai_settings WHERE user_id = $1',
    [userId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      enabled: row.enabled === true,
      seededFromWhatsapp: row.seeded_from_whatsapp === true,
      config: { ...DEFAULT_CONFIG, ...(row.config || {}) },
    };
  }
  // First open: seed from the merchant's WhatsApp config.
  const wa = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
  const seeded = seedConfigFromWhatsapp(wa.rows[0] && wa.rows[0].config);
  await database.query(
    `INSERT INTO instagram_ai_settings (user_id, enabled, seeded_from_whatsapp, config)
     VALUES ($1, false, true, $2::jsonb)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, JSON.stringify(seeded)],
  );
  return { enabled: false, seededFromWhatsapp: true, config: seeded };
}

async function saveInstagramConfig(userId, { enabled, config }, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `INSERT INTO instagram_ai_settings (user_id, enabled, seeded_from_whatsapp, config)
     VALUES ($1, $2, true, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = NOW()`,
    [userId, enabled === true, JSON.stringify(config || {})],
  );
}

async function setAiEnabled(userId, enabled, deps = {}) {
  const database = deps.database || db;
  // Ensure a row exists (seeds from WhatsApp if first time), then flip the flag.
  await resolveInstagramConfig(userId, deps);
  await database.query(
    'UPDATE instagram_ai_settings SET enabled = $2, updated_at = NOW() WHERE user_id = $1',
    [userId, enabled === true],
  );
}

module.exports = {
  seedConfigFromWhatsapp,
  resolveInstagramConfig,
  saveInstagramConfig,
  setAiEnabled,
};
