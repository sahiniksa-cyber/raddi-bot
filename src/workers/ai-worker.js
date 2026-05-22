'use strict';

require('dotenv').config({ quiet: true });

const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingWhatsapp } = require('../queues/message-queue');
const { buildEscalationJobKey } = require('../queues/outgoing-job-key');
const AIClient = require('../../lib/ai-client');
const { DEFAULT_CONFIG, MODEL_PRICES } = require('../../lib/constants');
const { buildHistoryForReply } = require('./ai-history');
const { prepareEscalation } = require('./escalation-routing');
const { resolveReplyDelayMs } = require('./reply-delay');
const { findAutoReply } = require('../services/bot/platform-features');
const {
  OpenAIMediaAnalyzer,
  buildMediaAnalysisText,
} = require('../services/ai/openai-media-analysis');

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

function computeCostUsd(model, inputTokens, outputTokens) {
  const prices = MODEL_PRICES[model] || MODEL_PRICES[model.replace(/^(openai|anthropic|google)\//, '')] || { in: 0.5, out: 1.5 };
  return ((inputTokens * prices.in) + (outputTokens * prices.out)) / 1_000_000;
}

async function recordAiUsage({ userId, model, inputTokens, outputTokens }) {
  if (!db.isConfigured() || !userId) return;
  const costUsd = computeCostUsd(model, inputTokens, outputTokens);
  await db.query(
    `INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, model, inputTokens || 0, outputTokens || 0, costUsd],
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

async function loadPendingInboundMessages({
  database = db,
  userId,
  conversationId,
  fallbackMessageId,
  fallbackText,
  limit = 20,
  maxAgeMs = parseInt(process.env.AI_PENDING_MAX_AGE_MS || '600000', 10),
  minProviderMessageTimeMs = Date.now() - Math.max(1, Number(maxAgeMs) || 1),
}) {
  if (!conversationId || !userId) {
    return fallbackText ? [{ id: fallbackMessageId, content: fallbackText, raw_payload: {} }] : [];
  }

  const result = await database.query(
    `WITH last_assistant AS (
       SELECT MAX(created_at) AS created_at
       FROM messages
       WHERE conversation_id = $1
         AND user_id = $2
         AND direction = 'outbound'
         AND role = 'assistant'
     )
     SELECT id, content, provider_message_id, raw_payload
     FROM messages m
     WHERE conversation_id = $1
       AND user_id = $2
       AND direction = 'inbound'
       AND status IN ('queued_for_ai', 'ai_failed')
       AND created_at > COALESCE((SELECT created_at FROM last_assistant), '-infinity'::timestamptz)
       AND m.created_at >= NOW() - ($4 * interval '1 millisecond')
       AND CASE
         WHEN COALESCE(m.raw_payload->>'timestamp', '') ~ '^[0-9]+(\\.[0-9]+)?$'
           THEN (m.raw_payload->>'timestamp')::double precision * 1000
         ELSE 0
       END >= $5
     ORDER BY created_at ASC
     LIMIT $3`,
    [
      conversationId,
      userId,
      limit,
      Math.max(1, Number(maxAgeMs) || 1),
      Math.max(1, Number(minProviderMessageTimeMs) || 1),
    ],
  );

  if (result.rows.length > 0) return result.rows;
  return [];
}

function buildCombinedInboundText(messages = []) {
  const parts = messages
    .map(message => String(message.content || '').trim())
    .filter(Boolean);

  if (parts.length <= 1) return parts[0] || '';
  return [
    'رسائل العميل المتتالية. أجب عليها كلها في رد واحد واضح:',
    ...parts.map((text, index) => `${index + 1}. ${text}`),
  ].join('\n');
}

async function enrichInboundMessagesWithMedia({ messages = [], analyzer, recordUsage = null }) {
  const enriched = [];
  for (const message of messages) {
    const raw = message.raw_payload || {};
    const media = raw.media || null;
    if (!media?.data || !analyzer) {
      enriched.push(message);
      continue;
    }

    const result = await analyzer.analyze(media, { customerText: message.content });
    if (result.ok) {
      if (typeof recordUsage === 'function' && result.usage) {
        try {
          await recordUsage(result.model, result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0);
        } catch (_) {}
      }
      enriched.push({
        ...message,
        content: buildMediaAnalysisText({
          kind: media.kind || result.kind,
          resultText: result.text,
          caption: media.caption,
        }),
      });
    } else {
      enriched.push({
        ...message,
        content: `${message.content}\n[تعذر تحليل الوسائط تلقائيا: ${result.reason || 'analysis_failed'}]`,
      });
    }
  }
  return enriched;
}

async function markInboundMessagesAnswered({ database = db, messageIds = [] }) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length || !database.isConfigured?.()) return;
  await database.query(
    `UPDATE messages
     SET status = 'answered_by_ai',
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
     WHERE id = ANY($1::uuid[])`,
    [ids, JSON.stringify({ answeredByAiAt: new Date().toISOString() })],
  );
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

async function markInboundMessageFailed({ database = db, messageId, error }) {
  if (!messageId || !database.isConfigured()) return;
  await database.query(
    `UPDATE messages
     SET status = $2,
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
     WHERE id = $1`,
    [
      messageId,
      'ai_failed',
      JSON.stringify({
        aiFailedAt: new Date().toISOString(),
        error: error?.message || String(error || 'AI failed'),
      }),
    ],
  );
}

async function processAiReply(job) {
  const payload = job.data || {};
  try {
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is required for AI worker');
    }

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

    const fallbackText = await loadInboundMessage({
      userId,
      messageId: payload.messageId,
      text: payload.text,
    });
    const pendingMessages = await loadPendingInboundMessages({
      database: db,
      userId,
      conversationId: conversation.id,
      fallbackMessageId: payload.messageId,
      fallbackText,
    });
    const mediaAnalyzer = new OpenAIMediaAnalyzer({
      apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY || '',
      logger,
    });
    const enrichedMessages = await enrichInboundMessagesWithMedia({
      messages: pendingMessages,
      analyzer: mediaAnalyzer,
      recordUsage: async (model, inputTokens, outputTokens) => {
        await recordAiUsage({ userId, model, inputTokens, outputTokens }).catch(() => {});
      },
    });
    const text = buildCombinedInboundText(enrichedMessages);
    if (!text.trim()) throw new Error('AI job has empty inbound text');

    const instantReply = findAutoReply(config, text);
    if (instantReply) {
      const replyMessageId = await storeAssistantMessage({
        userId,
        conversationId: conversation.id,
        sender: conversation.sender,
        reply: instantReply,
        jobId: job.id,
      });

      await enqueueOutgoingWhatsapp({
        userId,
        conversationId: conversation.id,
        messageId: payload.messageId,
        providerMessageId: payload.providerMessageId,
        replyMessageId,
        sender: conversation.sender,
        reply: instantReply,
        replyDelayMs: 0,
        replyDelayPreset: 'instant-keyword',
        source: 'auto_reply_keyword',
      }, {
        jobKey: String(replyMessageId),
        delay: 0,
      });

      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'completed',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
      });

      return { replyMessageId, queuedForSend: true, source: 'auto_reply_keyword' };
    }

    const history = await buildHistoryForReply({
      database: db,
      conversationId: conversation.id,
      config,
      inboundText: text,
    });

    const ai = new AIClient(config, logger, {
      record: async (model, inputTokens, outputTokens) => {
        await recordAiUsage({ userId, model, inputTokens, outputTokens }).catch(() => {});
      },
    });

    const reply = String(await ai.getReply(history, { isFirstMsg: history.filter(m => m.role === 'assistant').length === 0 }) || '').trim();
    if (!reply) throw new Error('AI returned empty reply');
    const escalation = prepareEscalation({
      reply,
      config,
      customerSender: conversation.sender,
      inboundText: text,
    });
    const customerReply = escalation.customerReply.trim();
    if (!customerReply) throw new Error('AI returned empty customer reply after escalation marker cleanup');

    const replyMessageId = await storeAssistantMessage({
      userId,
      conversationId: conversation.id,
      sender: conversation.sender,
      reply: customerReply,
      jobId: job.id,
    });
    const replyDelayMs = resolveReplyDelayMs(config);

    await enqueueOutgoingWhatsapp({
      userId,
      conversationId: conversation.id,
      messageId: payload.messageId,
      providerMessageId: payload.providerMessageId,
      replyMessageId,
      sender: conversation.sender,
      reply: customerReply,
      replyDelayMs,
      replyDelayPreset: config.replyDelayPreset,
    }, {
      jobKey: String(replyMessageId),
      delay: replyDelayMs,
    });

    if (escalation.ownerMessage) {
      await enqueueOutgoingWhatsapp({
        userId,
        conversationId: conversation.id,
        messageId: payload.messageId,
        providerMessageId: payload.providerMessageId,
        sender: escalation.ownerMessage.sender,
        reply: escalation.ownerMessage.reply,
        escalation: true,
        escalationSummary: escalation.ownerMessage.summary,
        customerSender: conversation.sender,
      }, {
        jobKey: buildEscalationJobKey(replyMessageId),
      });
    }

    await markInboundMessagesAnswered({
      messageIds: enrichedMessages.map(message => message.id),
    });

    await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
      status: 'completed',
      finished_at: new Date(),
      attempts: job.attemptsMade + 1,
    });

    return { replyMessageId, queuedForSend: true };
  } catch (err) {
    await markInboundMessageFailed({ messageId: payload.messageId, error: err }).catch(() => {});
    throw err;
  }
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
  buildCombinedInboundText,
  createWorker,
  enrichInboundMessagesWithMedia,
  loadPendingInboundMessages,
  markInboundMessageFailed,
  markInboundMessagesAnswered,
  processAiReply,
};
