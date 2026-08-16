'use strict';

/**
 * Trusted event-time resolution for SLA (PURE, no I/O) — Platform-level.
 *
 * SLA deadlines must be computed from a TRUSTED event timestamp
 * (trusted_event_timestamp + tenant_configured_sla = deadline), never from the
 * LLM guessing and never from `message_created_at` — the time a customer sent a
 * chat message is NOT when their order/request was created.
 *
 * This resolver picks the best available trusted timestamp from an ordered
 * priority list. Today only `escalation_thread_created_at` is wired; the other
 * sources are declared so a future integration (e.g. Salla order webhooks) can
 * supply them by simply adding the key to the `sources` object — no logic
 * change, no per-tenant hardcoding. If NO trusted source is present, the caller
 * must NOT claim an SLA breach and must NOT invent a time.
 */

// Ordered by how authoritative each source is for "when the SLA clock started".
// `message_created_at` is deliberately ABSENT — it is never an SLA anchor.
const TRUSTED_SLA_SOURCES = [
  'order_created_at',              // e.g. from an order integration (not wired yet)
  'payment_created_at',            // payment confirmation time (not wired yet)
  'ticket_created_at',             // support ticket open time (not wired yet)
  'last_status_changed_at',        // last trusted status transition (not wired yet)
  'escalation_thread_created_at',  // WIRED: when the request was escalated/registered
];

function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} sources - map of source-key → timestamp (Date|string|number|null).
 *   Only keys in TRUSTED_SLA_SOURCES are considered; order defines priority.
 * @returns {{source:string, timestamp:Date}|null}
 */
function resolveTrustedEventTimestamp(sources) {
  if (!sources || typeof sources !== 'object') return null;
  for (const source of TRUSTED_SLA_SOURCES) {
    const ts = toDate(sources[source]);
    if (ts) return { source, timestamp: ts };
  }
  return null;
}

module.exports = { TRUSTED_SLA_SOURCES, resolveTrustedEventTimestamp };
