'use strict';

/**
 * Human-takeover pause for Instagram DMs — the direct analog of the WhatsApp
 * owner-pause (conversations.escalated_until). When a human agent replies
 * manually from the dashboard inbox, the bot must stop auto-answering that
 * conversation for a window, so the customer isn't served two voices at once.
 *
 * Pure helpers only (no Express, no DB) so they are trivially unit-testable and
 * carry zero risk to WhatsApp.
 */

const DEFAULT_PAUSE_MINUTES = 30;

/**
 * Expiry Date for a pause of `minutes` starting at `nowMs`, or null when the
 * pause is disabled (minutes <= 0 or not a finite number). Mirrors the WhatsApp
 * ownerPauseExpiry contract exactly.
 */
function humanPauseExpiry(minutes, nowMs) {
  const m = parseInt(minutes, 10);
  if (!Number.isFinite(m) || m <= 0) return null;
  return new Date(nowMs + m * 60 * 1000);
}

/**
 * Resolve the pause window (minutes) from the environment. Defaults to 30 when
 * unset or invalid. A configured 0/negative value means "human reply does not
 * pause the bot" and is returned verbatim (0).
 */
function resolvePauseMinutes(env = process.env) {
  const raw = env.INSTAGRAM_HUMAN_PAUSE_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PAUSE_MINUTES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAUSE_MINUTES;
  return parsed < 0 ? 0 : parsed;
}

module.exports = { humanPauseExpiry, resolvePauseMinutes, DEFAULT_PAUSE_MINUTES };
