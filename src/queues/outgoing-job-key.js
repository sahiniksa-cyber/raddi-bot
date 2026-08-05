'use strict';

const { randomUUID } = require('crypto');

// BullMQ rejects job IDs that contain ":". Strip them unconditionally before
// returning any key so that legacy persisted keys (e.g. "ai-worker:jobid:uuid")
// cannot cause a "Custom Id cannot contain :" error during requeue.
function sanitize(k) {
  return String(k || '').trim().replace(/:/g, '-');
}

// A keyless outgoing job persists with job_key = NULL, which the worker can
// NEVER mark 'completed' (status updates key on job_key) — so the Phase-4
// requeue loop resends the same message every ~60s forever. Real customer
// replies always carry a replyMessageId, so only keyless CONTROL sends (e.g.
// prompt-edit systemNotice messages to the escalation group) hit this. Force a
// stable, non-null key at enqueue time so every outgoing job can complete.
// (Root cause of the 2026-08 confirm/menu repeat loop.)
function ensureNonEmptyOutgoingJobKey(key) {
  const k = String(key || '').trim();
  return k || `sys-${randomUUID()}`;
}

function buildEscalationJobKey(replyMessageId) {
  const base = String(replyMessageId || '').trim() || `manual-${Date.now()}`;
  return `${base.replace(/:/g, '-')}-escalation`;
}

// Anchors the outgoing job key on replyMessageId for normal AI replies (escalation
// gets its own dedicated key via buildEscalationJobKey). Each generated reply has
// a unique replyMessageId, so a duplicate enqueue cannot create a second BullMQ job.
function normalizeOutgoingJobKey(jobKey, payload = {}) {
  if (payload && payload.escalation) {
    const raw = String(jobKey || '').trim();
    if (raw.endsWith(':escalation')) {
      return buildEscalationJobKey(raw.slice(0, -':escalation'.length));
    }
    if (raw.endsWith('-escalation')) return sanitize(raw);
    return buildEscalationJobKey(payload.replyMessageId || raw);
  }

  // Prefer replyMessageId as the authoritative dedup key. Fall back to caller-supplied
  // jobKey only when no replyMessageId exists (legacy / manual sends).
  const replyKey = String(payload?.replyMessageId || '').trim();
  if (replyKey) return sanitize(replyKey);

  return sanitize(jobKey);
}

module.exports = {
  buildEscalationJobKey,
  normalizeOutgoingJobKey,
  ensureNonEmptyOutgoingJobKey,
};
