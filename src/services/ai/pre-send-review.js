'use strict';

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

function compactAudit(audit = {}, source = 'ai_reply') {
  const shortList = (value, limit = 10) => Array.isArray(value)
    ? value.filter(Boolean).slice(0, limit).map(item => String(item).slice(0, 240))
    : [];
  return {
    status: 'reviewed',
    decision: String(audit.decision || 'pass').slice(0, 32),
    reason: String(audit.reason || '').slice(0, 240),
    repeatedClaims: shortList(audit.repeatedClaims),
    violations: shortList(audit.violations),
    unsupportedClaims: shortList(audit.unsupportedClaims),
    hardFallback: audit.hardFallback === true,
    latencyMs: Math.max(0, parseInt(audit.latencyMs, 10) || 0),
    source: String(source || 'ai_reply').slice(0, 64),
    reviewedAt: new Date().toISOString(),
  };
}

function normalizeHistory(rows = []) {
  return rows.slice().reverse().map((row) => ({
    role: row.role === 'assistant' || row.direction === 'outbound' ? 'assistant' : 'user',
    content: String(row.content || '').trim(),
  })).filter(message => message.content);
}

async function loadReviewContext({ database, userId, conversationId, replyMessageId }) {
  let currentMessage = null;
  if (replyMessageId) {
    const current = await database.query(
      `SELECT id, content, raw_payload
         FROM messages
        WHERE user_id = $1 AND id = $2
        LIMIT 1`,
      [userId, replyMessageId],
    );
    currentMessage = current.rows[0];
    if (!currentMessage) throw new Error('pre-send review could not find the outbound message');

    const rawPayload = asObject(currentMessage.raw_payload);
    const persisted = asObject(rawPayload.preSendReview);
    if (persisted.status === 'reviewed') {
      return {
        reused: true,
        suppressed: persisted.decision === 'suppress',
        reply: persisted.decision === 'suppress' ? '' : String(currentMessage.content || '').trim(),
        audit: persisted,
        history: [],
        customerText: '',
      };
    }
  }

  const recent = await database.query(
    `SELECT role, direction, content, status, created_at
       FROM messages
      WHERE user_id = $1
        AND conversation_id = $2
        AND ($3::uuid IS NULL OR id <> $3)
        AND (
          direction = 'inbound'
          OR (direction = 'outbound' AND status = 'sent')
        )
      ORDER BY created_at DESC
      LIMIT 16`,
    [userId, conversationId, replyMessageId],
  );
  const history = normalizeHistory(recent.rows);
  const customerText = [...history].reverse().find(message => message.role === 'user')?.content || '';
  return {
    reused: false,
    suppressed: false,
    reply: String(currentMessage?.content || '').trim(),
    audit: null,
    history,
    customerText,
  };
}

async function persistReview({ database, userId, replyMessageId, reply, suppressed, audit }) {
  await database.query(
    `UPDATE messages
        SET content = $3,
            status = CASE WHEN $4::boolean THEN 'canceled' ELSE status END,
            raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $5::jsonb
      WHERE user_id = $1 AND id = $2`,
    [
      userId,
      replyMessageId,
      suppressed ? '' : reply,
      suppressed,
      JSON.stringify({ preSendReview: audit }),
    ],
  );
}

/**
 * Fail-closed final review. Callers must not send payload.reply when this
 * function throws; BullMQ will retry and the customer never receives an
 * unreviewed message.
 */
async function reviewOutgoingReplyBeforeSend({
  database,
  bot,
  payload = {},
  userId,
  conversationId,
  replyMessageId,
  draft,
} = {}) {
  if (payload.preSendReviewRequired !== true) {
    return { reply: String(draft || '').trim(), suppressed: false, bypassed: true };
  }
  if (!database?.isConfigured?.()) throw new Error('pre-send review requires the database');
  if (!userId || !conversationId) {
    throw new Error('pre-send review requires userId and conversationId');
  }
  if (typeof bot?.reviewReplyBeforeSend !== 'function') {
    throw new Error('pre-send reviewer is unavailable on the connected bot');
  }

  const context = await loadReviewContext({ database, userId, conversationId, replyMessageId });
  if (context.reused) return { ...context, bypassed: false };

  // The database row is the source of truth. It contains the post-composition
  // text stored by ai-worker and avoids a stale queue payload on retries.
  const finalDraft = context.reply || String(draft || '').trim();
  const reviewed = await bot.reviewReplyBeforeSend({
    draft: finalDraft,
    history: context.history,
    customerText: context.customerText,
    source: payload.source || 'ai_reply',
  });
  const suppressed = reviewed?.suppressed === true;
  const reply = suppressed ? '' : String(reviewed?.reply || '').trim();
  if (!suppressed && !reply) throw new Error('pre-send reviewer returned an empty reply');

  const audit = compactAudit({
    ...(reviewed?.audit || {}),
    decision: suppressed ? 'suppress' : (reviewed?.audit?.decision || 'pass'),
  }, payload.source);
  if (replyMessageId) {
    await persistReview({ database, userId, replyMessageId, reply, suppressed, audit });
  }
  return { reply, suppressed, audit, reused: false, bypassed: false };
}

module.exports = {
  compactAudit,
  loadReviewContext,
  normalizeHistory,
  persistReview,
  reviewOutgoingReplyBeforeSend,
};
