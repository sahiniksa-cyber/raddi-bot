'use strict';

/**
 * Fail-safe Instagram error/event log. Writes to `instagram_logs`. Logging
 * must NEVER break the caller — a DB failure here is swallowed (isolation
 * invariant), so a logging problem can never cascade into WhatsApp or the
 * message pipeline.
 */

const db = require('../../db/client');

async function logInstagram(userId, level, eventType, detail, deps = {}) {
  const database = deps.database || db;
  try {
    await database.query(
      `INSERT INTO instagram_logs (user_id, level, event_type, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId || null, level || 'info', eventType || null, JSON.stringify(detail || {})],
    );
  } catch (err) {
    console.error(`${new Date().toISOString()} [instagram-logs] failed: ${err.message}`);
  }
}

module.exports = { logInstagram };
