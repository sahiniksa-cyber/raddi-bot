'use strict';

const db = require('../db/client');
const { enqueueAiReply } = require('../queues/message-queue');

async function recoverQueuedAiReplyJobs({
  database = db,
  enqueue = enqueueAiReply,
  limit = parseInt(process.env.AI_RECOVERY_LIMIT || '100', 10),
  maxAgeMs = parseInt(process.env.AI_RECOVERY_MAX_AGE_MS || '600000', 10),
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
    try {
      await enqueue({
        userId: row.user_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        sender: row.sender,
        text: row.content,
        providerMessageId: row.provider_message_id,
        source: 'ai_recovery',
      }, {
        jobKey: `conversation-${row.conversation_id}`,
        delay: 0,
      });
      recovered++;
    } catch (err) {
      logger.warn?.('queue', `failed to recover AI reply job ${row.message_id}: ${err.message}`);
    }
  }

  return { recovered };
}

module.exports = { recoverQueuedAiReplyJobs };
