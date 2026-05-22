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
       AND m.status = 'queued_for_ai'
       AND m.created_at >= NOW() - ($2 * interval '1 millisecond')
     ORDER BY m.conversation_id, m.created_at DESC
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

module.exports = { recoverQueuedAiReplyJobs, reviveExistingAiJob };
