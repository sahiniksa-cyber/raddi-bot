'use strict';

const {
  asObject,
  normalizeReviewMessage,
  normalizeSessionGapMs,
  trimToCurrentSession,
} = require('./conversation-context');

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
    confidence: Math.min(1, Math.max(0, Number.isFinite(Number(audit.confidence)) ? Number(audit.confidence) : 1)),
    requiresHuman: audit.requiresHuman === true,
    humanReason: String(audit.humanReason || '').slice(0, 240),
    handoffSummary: String(audit.handoffSummary || '').slice(0, 240),
    latencyMs: Math.max(0, parseInt(audit.latencyMs, 10) || 0),
    source: String(source || 'ai_reply').slice(0, 64),
    reviewedAt: new Date().toISOString(),
  };
}

function normalizeHistory(rows = []) {
  const chronological = rows.slice().reverse();
  const sessionGapMs = normalizeSessionGapMs(process.env.PRE_SEND_REVIEW_SESSION_GAP_MS);
  return trimToCurrentSession(chronological, sessionGapMs)
    .map(normalizeReviewMessage)
    .filter(message => message.content);
}

async function loadReviewContext({
  database,
  userId,
  channelId = 'whatsapp',
  conversationId,
  customerId,
  replyMessageId,
}) {
  if (!userId || channelId !== 'whatsapp' || !conversationId || !customerId) {
    throw new Error('pre-send review context requires tenant, channel, conversation, and customer');
  }
  let currentMessage = null;
  if (replyMessageId) {
    const current = await database.query(
      `SELECT id, content, raw_payload
         FROM messages
        WHERE user_id = $1
          AND conversation_id = $3
          AND channel_id = $4
          AND sender = $5
          AND id = $2
        LIMIT 1`,
      [userId, replyMessageId, conversationId, channelId, customerId],
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
    `SELECT role, direction, content, status, raw_payload, created_at
       FROM messages
      WHERE user_id = $1
        AND conversation_id = $2
        AND channel_id = $4
        AND sender = $5
        AND ($3::uuid IS NULL OR id <> $3)
        AND (
          direction = 'inbound'
          OR (direction = 'outbound' AND status IN ('sent', 'sent_by_human'))
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 16`,
    [userId, conversationId, replyMessageId, channelId, customerId],
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

async function persistReview({
  database,
  userId,
  channelId = 'whatsapp',
  conversationId,
  customerId,
  replyMessageId,
  reply,
  suppressed,
  audit,
}) {
  await database.query(
    `UPDATE messages
        SET content = $3,
            status = CASE WHEN $4::boolean THEN 'canceled' ELSE status END,
            raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $5::jsonb
      WHERE user_id = $1
        AND id = $2
        AND conversation_id = $6
        AND channel_id = $7
        AND sender = $8`,
    [
      userId,
      replyMessageId,
      suppressed ? '' : reply,
      suppressed,
      JSON.stringify({ preSendReview: audit }),
      conversationId,
      channelId,
      customerId,
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

  const channelId = payload.channelId || 'whatsapp';
  if (channelId !== 'whatsapp') throw new Error('pre-send review channel mismatch');
  const customerId = payload.customerId || payload.sender;
  if (!customerId || (payload.customerId && payload.sender && payload.customerId !== payload.sender)) {
    throw new Error('pre-send review customer scope mismatch');
  }
  const context = await loadReviewContext({
    database,
    userId,
    channelId,
    conversationId,
    customerId,
    replyMessageId,
  });
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
    await persistReview({
      database,
      userId,
      channelId,
      conversationId,
      customerId,
      replyMessageId,
      reply,
      suppressed,
      audit,
    });
  }
  return {
    reply,
    suppressed,
    requiresHuman: reviewed?.requiresHuman === true || audit.requiresHuman === true,
    audit,
    reused: false,
    bypassed: false,
  };
}

module.exports = {
  compactAudit,
  loadReviewContext,
  normalizeHistory,
  persistReview,
  reviewOutgoingReplyBeforeSend,
};
