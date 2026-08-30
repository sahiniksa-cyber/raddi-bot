'use strict';

/**
 * Single source of truth for the Human Takeover (owner-pause) window duration.
 *
 * Platform-level & multi-tenant: the duration is read PER MERCHANT from
 * bot_configs.config->>'ownerPauseMinutes'. Nothing here is hardcoded to a
 * tenant; the constant below is only the PLATFORM DEFAULT used when a merchant
 * has no configured (or an invalid) value — never a silent override of a valid
 * configured value.
 */

// Platform default takeover window when a merchant has not configured one.
const DEFAULT_OWNER_PAUSE_MINUTES = 30;

/**
 * Parses a raw config value into a takeover-window minute count.
 * - null / undefined (not configured)  → platform default
 * - non-numeric (invalid)              → platform default
 * - a finite number (incl. 0 / <0)     → that value verbatim (0/<0 = disabled)
 */
function parseOwnerPauseMinutes(raw) {
  if (raw === null || raw === undefined) return DEFAULT_OWNER_PAUSE_MINUTES;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_OWNER_PAUSE_MINUTES;
}

/**
 * Reads the merchant's configured takeover minutes from bot_configs.
 * Never throws — returns the platform default on any error/missing row.
 */
async function readOwnerPauseMinutes(db, userId) {
  try {
    const result = await db.query(
      `SELECT (config->>'ownerPauseMinutes') AS owner_pause_minutes
         FROM bot_configs WHERE user_id = $1`,
      [userId],
    );
    return parseOwnerPauseMinutes(result?.rows?.[0]?.owner_pause_minutes);
  } catch (_e) {
    return DEFAULT_OWNER_PAUSE_MINUTES;
  }
}

module.exports = {
  DEFAULT_OWNER_PAUSE_MINUTES,
  parseOwnerPauseMinutes,
  readOwnerPauseMinutes,
};
