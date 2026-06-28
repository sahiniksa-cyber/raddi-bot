'use strict';

const db = require('../../db/client');

async function getPlatformSetting(key, { database = db } = {}) {
  const r = await database.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setPlatformSetting(key, value, { database = db } = {}) {
  await database.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
  return value;
}

module.exports = { getPlatformSetting, setPlatformSetting };
