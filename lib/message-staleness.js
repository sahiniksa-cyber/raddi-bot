'use strict';

// ── SINGLE SOURCE OF TRUTH for "is this customer message too old to answer?" ──
//
// THE RULE (one rule, no exceptions): a customer message whose ORIGINAL
// send-time (the WhatsApp timestamp, not the DB insert time) is older than
// STALE_MAX_AGE_MS measured FROM NOW is never answered.
//
// Why this module exists: the old code froze the cutoff at process-start
// (`startupTime - 30min`), so a long-running process had a multi-hour
// acceptance window. When the WhatsApp link flapped and the server re-delivered
// hours-old backlog, those messages slipped in, got a fresh `created_at`, and
// looked brand-new to every downstream guard — so the bot answered ancient
// conversations (production incident 2026-06-12). The cutoff MUST slide with
// real time, and it MUST be checked against the original timestamp at every
// layer. This module is that shared, sliding, original-timestamp policy.

const DEFAULT_STALE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function staleMaxAgeMs() {
  // One knob, used everywhere. WA_ACCEPT_MESSAGES_GRACE_MS kept as the name for
  // backward compatibility with existing deploys/env.
  const raw = parseInt(process.env.WA_ACCEPT_MESSAGES_GRACE_MS || String(DEFAULT_STALE_MAX_AGE_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_MAX_AGE_MS;
}

// SLIDING cutoff: always relative to NOW, never frozen.
function staleCutoffMs(nowMs = Date.now()) {
  return nowMs - staleMaxAgeMs();
}

// Normalize a provider timestamp to milliseconds. WhatsApp sends seconds;
// some paths already carry ms. Anything < 1e12 is treated as seconds.
function toMillis(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// The core decision. Returns true ONLY when we have a valid original timestamp
// AND it is older than the sliding cutoff. A missing/invalid timestamp returns
// false (fail-open: never drop a message just because its timestamp is absent —
// that bug previously caused "empty inbound text" loops).
function isOriginalMessageStale(originalTimestamp, nowMs = Date.now()) {
  const ms = toMillis(originalTimestamp);
  if (ms === null) return false;
  return ms < staleCutoffMs(nowMs);
}

module.exports = {
  DEFAULT_STALE_MAX_AGE_MS,
  staleMaxAgeMs,
  staleCutoffMs,
  toMillis,
  isOriginalMessageStale,
};
