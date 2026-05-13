'use strict';

function buildEscalationJobKey(replyMessageId) {
  const base = String(replyMessageId || '').trim() || `manual-${Date.now()}`;
  return `${base.replace(/:/g, '-')}-escalation`;
}

function normalizeOutgoingJobKey(jobKey, payload = {}) {
  const raw = String(jobKey || '').trim();
  if (!raw) return raw;
  if (payload.escalation && raw.endsWith(':escalation')) {
    return buildEscalationJobKey(raw.slice(0, -':escalation'.length));
  }
  return raw;
}

module.exports = {
  buildEscalationJobKey,
  normalizeOutgoingJobKey,
};
