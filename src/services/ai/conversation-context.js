'use strict';

const DEFAULT_CONTEXT_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeSessionGapMs(value, fallback = DEFAULT_CONTEXT_SESSION_GAP_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : fallback;
}

function isOwnerMessage(row = {}) {
  if (row.status === 'sent_by_human') return true;
  const raw = asObject(row.raw_payload);
  return row.direction === 'outbound' && raw.source === 'manual_send';
}

function classifyMessageSpeaker(row = {}) {
  if (row.direction === 'inbound' || row.role === 'user') return 'customer';
  return isOwnerMessage(row) ? 'owner' : 'bot';
}

function timestampMs(row = {}) {
  const value = row.created_at ?? row.createdAt;
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows must be chronological. A long silence starts a new conversational
 * session, so an old resolved topic cannot become context for today's reply.
 * Rows without timestamps retain the legacy behavior.
 */
function trimToCurrentSession(rows = [], gapMs = DEFAULT_CONTEXT_SESSION_GAP_MS) {
  const chronological = Array.isArray(rows) ? rows.slice() : [];
  const limit = normalizeSessionGapMs(gapMs);
  let sessionStart = 0;

  for (let index = 1; index < chronological.length; index++) {
    const previous = timestampMs(chronological[index - 1]);
    const current = timestampMs(chronological[index]);
    if (previous !== null && current !== null && current - previous > limit) {
      sessionStart = index;
    }
  }
  return chronological.slice(sessionStart);
}

function normalizeReviewMessage(row = {}) {
  const speaker = classifyMessageSpeaker(row);
  return {
    role: speaker === 'customer' ? 'user' : 'assistant',
    speaker,
    content: String(row.content || '').trim(),
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

module.exports = {
  DEFAULT_CONTEXT_SESSION_GAP_MS,
  asObject,
  classifyMessageSpeaker,
  isOwnerMessage,
  normalizeReviewMessage,
  normalizeSessionGapMs,
  trimToCurrentSession,
};
