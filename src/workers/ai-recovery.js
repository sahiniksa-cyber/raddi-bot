'use strict';

const db = require('../db/client');
const { enqueueAiReply } = require('../queues/message-queue');
const { getQueues } = require('../queues/message-queue');

async function markPersistedAiJobQueued(database, jobKey) {
  if (!database.isConfigured?.() || !jobKey) return;
  await database.query(
    `UPDATE jobs
     SET status = 'queued',
         attempts = 0,
         last_error = NULL,
         available_at = NOW(),
         finished_at = NULL,
         updated_at = NOW()
     WHERE queue_name = 'ai-replies' AND job_key = $1`,
    [jobKey],
  );
}

async function reviveExistingAiJob({ aiQueue, database, jobKey }) {
  const queue = aiQueue || getQueues().aiReplies;
  const existing = await queue.getJob(jobKey).catch(() => null);
  if (!existing) return false;

  const state = await existing.getState().catch(() => null);
  if (state === 'failed') {
    await existing.retry('failed');
    await markPersistedAiJobQueued(database, jobKey).catch(() => {});
    return true;
  }
  if (['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'].includes(state)) {
    await markPersistedAiJobQueued(database, jobKey).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Mark inbound messages that have been stuck `queued_for_ai` for longer than
 * the recovery/pending window as `ai_failed`. Such messages can no longer be
 * loaded by the worker (its `loadPendingInboundMessages` is bounded by the same
 * age) nor picked up by recovery below — so they would otherwise sit in the
 * stuck-count forever and make the worker throw "empty inbound text" on every
 * recovery cycle. Expiring them clears the stuck count and stops the loop.
 * They are NOT answered (replying to 30-min-old messages is wrong) — they are
 * simply retired.
 */
async function expireStaleQueuedMessages({
  database = db,
  maxAgeMs = parseInt(process.env.AI_PENDING_MAX_AGE_MS || '1800000', 10),
} = {}) {
  if (!database.isConfigured?.()) return { expired: 0 };
  const safeMaxAgeMs = Math.max(1, Number(maxAgeMs) || 1);
  const result = await database.query(
    `UPDATE messages
        SET status = 'ai_failed',
            raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $1::jsonb
      WHERE direction = 'inbound'
        AND status = 'queued_for_ai'
        AND created_at < NOW() - ($2 * interval '1 millisecond')`,
    [
      JSON.stringify({ aiExpiredAt: new Date().toISOString(), reason: 'expired_unprocessed' }),
      safeMaxAgeMs,
    ],
  );
  return { expired: result.rowCount || 0 };
}

async function recoverQueuedAiReplyJobs({
  database = db,
  enqueue = enqueueAiReply,
  aiQueue = null,
  limit = parseInt(process.env.AI_RECOVERY_LIMIT || '100', 10),
  maxAgeMs = parseInt(process.env.AI_RECOVERY_MAX_AGE_MS || '1800000', 10),
  logger = console,
} = {}) {
  if (!database.isConfigured?.()) return { recovered: 0 };
  const safeMaxAgeMs = Math.max(1, Number(maxAgeMs) || 1);

  // Retire messages too old to ever be processed so they stop inflating the
  // stuck count and triggering the empty-inbound-text loop.
  const { expired } = await expireStaleQueuedMessages({ database }).catch(() => ({ expired: 0 }));
  if (expired > 0) {
    logger.warn?.('queue', `expired ${expired} stale queued_for_ai messages (older than pending window)`);
  }

  const result = await database.query(
    `SELECT DISTINCT ON (m.conversation_id)
            m.user_id,
            m.conversation_id,
            m.id AS message_id,
            m.sender,
            m.content,
            m.provider_message_id
     FROM messages m
     WHERE m.direction = 'inbound'
       AND m.channel_id = 'whatsapp'
       AND m.status = 'queued_for_ai'
       AND m.created_at >= NOW() - ($2 * interval '1 millisecond')
     ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
     LIMIT $1`,
    [Math.max(1, limit), safeMaxAgeMs],
  );

  let recovered = 0;
  for (const row of result.rows) {
    const jobKey = `conversation-${row.conversation_id}`;
    try {
      if (aiQueue && await reviveExistingAiJob({ aiQueue, database, jobKey })) {
        recovered++;
        continue;
      }

      await enqueue({
        userId: row.user_id,
        tenantId: row.user_id,
        channelId: 'whatsapp',
        customerId: row.sender,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        sender: row.sender,
        text: row.content,
        providerMessageId: row.provider_message_id,
        source: 'ai_recovery',
      }, {
        jobKey,
        delay: 0,
      });
      recovered++;
    } catch (err) {
      if (/already exists/i.test(err.message) && await reviveExistingAiJob({ aiQueue, database, jobKey }).catch(() => false)) {
        recovered++;
      } else {
        logger.warn?.('queue', `failed to recover AI reply job ${row.message_id}: ${err.message}`);
      }
    }
  }

  return { recovered };
}

module.exports = { recoverQueuedAiReplyJobs, reviveExistingAiJob, expireStaleQueuedMessages };
