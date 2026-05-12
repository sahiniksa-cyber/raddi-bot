'use strict';

require('dotenv').config({ quiet: true });

const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingWhatsapp } = require('../queues/message-queue');
const AIClient = require('../../lib/ai-client');
const { DEFAULT_CONFIG } = require('../../lib/constants');

const WORKER_NAME = 'ai-worker';
const CONCURRENCY = parseInt(process.env.AI_WORKER_CONCURRENCY || '2', 10);
const RATE_LIMIT_MAX = parseInt(process.env.AI_WORKER_RATE_LIMIT_MAX || '15', 10);
const RATE_LIMIT_DURATION_MS = parseInt(process.env.AI_WORKER_RATE_LIMIT_DURATION_MS || '60000', 10);

function createLogger(jobId) {
  const prefix = `[${WORKER_NAME}:${jobId || 'manual'}]`;
  const write = (level, stage, message, meta) => {
    const payload = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `${new Date().toISOString()} ${prefix} [${level}] [${stage}] ${message}${payload}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    info: (stage, message, meta) => write('info', stage, message, meta),
    warn: (stage, message, meta) => write('warn', stage, message, meta),
    error: (stage, message, meta) => write('error', stage, message, meta),
  };
}

async function updateJobStatus(queueName, jobKey, fields) {
  if (!db.isConfigured() || !jobKey) return;

  const assignments = [];
  const values = [queueName, jobKey];
  let i = values.length;

  for (const [key, value] of Object.entries(fields)) {
    i++;
    assignments.push(`${key} = $${i}`);
    values.push(value);
  }

  if (assignments.length === 0) return;

  await db.query(
    `UPDATE jobs
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE queue_name = $1 AND job_key = $2`,
    values,
  );
}

async function loadConfig(userId) {
  const result = await db.query(
    'SELECT config FROM bot_configs WHERE user_id = $1',
    [userId],
  );
  return { ...DEFAULT_CONFIG, ...(result.rows[0]?.config || {}) };
}

async function resolveConversation({ userId, conversationId, sender }) {
  if (conversationId) {
    const result = await db.query(
      'SELECT id, sender FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId],
    );
    if (result.rows[0]) return result.rows[0];
  }

  if (!sender) return null;

  const result = await db.query(
    `INSERT INTO conversations (user_id, sender)
     VALUES ($1, $2)
     ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
     RETURNING id, sender`,
    [userId, sender],
  );
  return result.rows[0] || null;
}

async function loadInboundMessage({ userId, messageId, text }) {
  if (text) return text;
  if (!messageId) return '';

  const result = await db.query(
    `SELECT content FROM messages
     WHERE id = $1 AND user_id = $2 AND direction = 'inbound'
     LIMIT 1`,
    [messageId, userId],
  );

  return result.rows[0]?.content || '';
}

async function loadHistory(conversationId, limit) {
  const result = await db.query(
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  return result.rows
    .reverse()
    .map(row => ({ role: row.role, content: row.content }));
}

async function storeAssistantMessage({ userId, conversationId, sender, reply, jobId }) {
  const result = await db.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'queued_for_send', $6::jsonb)
     RETURNING id`,
    [
      conversationId,
      userId,
      sender,
      reply,
      `ai-worker:${jobId}`,
      JSON.stringify({ source: WORKER_NAME, jobId }),
    ],
  );

  await db.query(
    `UPDATE conversations
     SET last_message_at = NOW()
     WHERE id = $1`,
    [conversationId],
  );

  return result.rows[0].id;
}

async function processAiReply(job) {
  if (!db.isConfigured()) {
    throw new Error('DATABASE_URL is required for AI worker');
  }

  const payload = job.data || {};
  const userId = payload.userId;
  if (!userId) throw new Error('Missing userId in AI job payload');

  await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
    status: 'processing',
    started_at: new Date(),
    attempts: job.attemptsMade,
  });

  const logger = createLogger(job.id);
  const config = await loadConfig(userId);
  const conversation = await resolveConversation({
    userId,
    conversationId: payload.conversationId,
    sender: payload.sender,
  });
  if (!conversation) throw new Error('Unable to resolve conversation');

  const text = await loadInboundMessage({
    userId,
    messageId: payload.messageId,
    text: payload.text,
  });
  if (!text.trim()) throw new Error('AI job has empty inbound text');

  const memSize = Math.max(2, parseInt(config.memoryMessages, 10) || 50);
  const history = await loadHistory(conversation.id, memSize);
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || last.content !== text) {
    history.push({ role: 'user', content: text });
  }
  if (history.length > memSize) history.splice(0, history.length - memSize);

  const ai = new AIClient(config, logger, {
    record: async () => {},
  });

  const reply = String(await ai.getReply(history, { isFirstMsg: history.filter(m => m.role === 'assistant').length === 0 }) || '').trim();
  if (!reply) throw new Error('AI returned empty reply');

  const replyMessageId = await storeAssistantMessage({
    userId,
    conversationId: conversation.id,
    sender: conversation.sender,
    reply,
    jobId: job.id,
  });

  await enqueueOutgoingWhatsapp({
    userId,
    conversationId: conversation.id,
    messageId: payload.messageId,
    providerMessageId: payload.providerMessageId,
    replyMessageId,
    sender: conversation.sender,
    reply,
  }, {
    jobKey: String(replyMessageId),
  });

  await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
    status: 'completed',
    finished_at: new Date(),
    attempts: job.attemptsMade + 1,
  });

  return { replyMessageId, queuedForSend: true };
}

function createWorker() {
  const connection = createRedisConnection();
  return new Worker(QUEUE_NAMES.aiReplies, processAiReply, {
    connection,
    concurrency: CONCURRENCY,
    limiter: {
      max: RATE_LIMIT_MAX,
      duration: RATE_LIMIT_DURATION_MS,
    },
    lockDuration: parseInt(process.env.AI_WORKER_LOCK_DURATION_MS || '120000', 10),
  });
}

async function main() {
  const worker = createWorker();

  worker.on('completed', (job) => {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] completed ${job.id}`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] failed ${job?.id}: ${err.message}`);
    if (job?.id) {
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'failed',
        last_error: err.message,
        attempts: job.attemptsMade,
      }).catch(() => {});
    }
  });

  const shutdown = async (signal) => {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] ${signal} shutdown`);
    await worker.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] fatal: ${err.stack || err.message}`);
    await db.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  createWorker,
  processAiReply,
};
