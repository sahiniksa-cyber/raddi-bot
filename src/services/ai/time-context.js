'use strict';

/**
 * Conversation time context (PURE, no I/O) — Platform-level & Multi-Tenant.
 *
 * Gives the model a RELIABLE sense of real time: the current time and each
 * message's clock time, rendered in EACH tenant's own timezone. Everything is
 * derived from the tenant's config + the message's own created_at — nothing is
 * hardcoded per store, and no time is invented.
 *
 * This is conversation/message TIME. It is NOT an SLA anchor: message_created_at
 * must never be treated as order_created_at. SLA deadlines are computed
 * separately from a TRUSTED event timestamp (see trusted-event-time.js).
 */

// Platform default timezone (overridable per-tenant via config.timezone, and
// globally via env). Not per-store logic — a fallback locale, like a default
// currency. Any tenant overrides it from their own settings.
const PLATFORM_DEFAULT_TIMEZONE = (process.env.DEFAULT_TENANT_TIMEZONE || 'Asia/Riyadh').trim();

function resolveTenantTimezone(config = {}) {
  const tz = String(
    (config && (config.timezone || config.tenantTimezone)) || '',
  ).trim();
  return tz || PLATFORM_DEFAULT_TIMEZONE;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Extract Y/M/D/H/M parts of an instant AS SEEN in a given IANA timezone.
function partsInTimezone(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  // 'en-CA' hour can render '24' at midnight in some environments — normalize.
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

function formatDateTime(value, timezone) {
  const date = toDate(value);
  if (!date) return '';
  const tz = timezone || PLATFORM_DEFAULT_TIMEZONE;
  const p = partsInTimezone(date, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function formatClock(value, timezone) {
  const date = toDate(value);
  if (!date) return '';
  const tz = timezone || PLATFORM_DEFAULT_TIMEZONE;
  const p = partsInTimezone(date, tz);
  return `${p.hour}:${p.minute}`;
}

/**
 * System-prompt block stating the current time in the tenant timezone, and
 * telling the model the bracketed per-message times are reference-only.
 */
function buildCurrentTimeBlock({ now, timezone } = {}) {
  const date = toDate(now);
  if (!date) return '';
  const tz = timezone || PLATFORM_DEFAULT_TIMEZONE;
  const stamp = formatDateTime(date, tz);
  if (!stamp) return '';
  return `\n\n🕒 الوقت الحالي: ${stamp} (بتوقيت المتجر). الأوقات بين الأقواس [مثل 21:30] قبل كل رسالة هي وقت إرسالها — مرجع لك فقط لفهم تسلسل وفجوات الوقت، لا تكتبها في ردّك ولا تحسب منها أي مدة رسمية.`;
}

/**
 * Prefix a message with its clock time: "[21:30] النص". Returns the content
 * unchanged when there is no reliable timestamp (never fabricates a time).
 */
function withTimestampPrefix(content, ts, timezone) {
  const clock = formatClock(ts, timezone);
  const text = String(content == null ? '' : content);
  return clock ? `[${clock}] ${text}` : text;
}

module.exports = {
  PLATFORM_DEFAULT_TIMEZONE,
  resolveTenantTimezone,
  formatDateTime,
  formatClock,
  buildCurrentTimeBlock,
  withTimestampPrefix,
};
