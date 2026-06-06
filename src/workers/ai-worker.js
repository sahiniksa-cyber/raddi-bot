'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingWhatsapp, enqueueAiReply } = require('../queues/message-queue');
const { buildEscalationJobKey } = require('../queues/outgoing-job-key');
const AIClient = require('../../lib/ai-client');
const { DEFAULT_CONFIG, MODEL_PRICES } = require('../../lib/constants');
const { buildHistoryForReply } = require('./ai-history');
const { prepareEscalation } = require('./escalation-routing');
const { findDuplicateRecentReply } = require('./reply-deduplication');
const { getProfile: getCustomerProfile, extractAsync: extractCustomerProfileAsync } = require('./profile-extractor');
const { resolveReplyDelayMs } = require('./reply-delay');
const { findAutoReply, collectInstantReplies } = require('../services/bot/platform-features');
const { resolveConfigForAI } = require('../services/bot/runtime-bot');
const { checkMessageQuota } = require('../services/billing/message-quota');
const {
  OpenAIMediaAnalyzer,
  buildMediaAnalysisText,
} = require('../services/ai/openai-media-analysis');

const WORKER_NAME = 'ai-worker';
const CONCURRENCY = parseInt(process.env.AI_WORKER_CONCURRENCY || '2', 10);
const RATE_LIMIT_MAX = parseInt(process.env.AI_WORKER_RATE_LIMIT_MAX || '15', 10);
const RATE_LIMIT_DURATION_MS = parseInt(process.env.AI_WORKER_RATE_LIMIT_DURATION_MS || '60000', 10);
const DB_READY_TIMEOUT_MS = parseInt(process.env.AI_WORKER_DB_READY_TIMEOUT_MS || '120000', 10);
const DB_READY_INTERVAL_MS = parseInt(process.env.AI_WORKER_DB_READY_INTERVAL_MS || '2000', 10);
const AI_REPLY_DEBOUNCE_MS = parseInt(process.env.AI_REPLY_DEBOUNCE_MS || '9000', 10);

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
      'SELECT id, sender, phone_number FROM conversations WHERE id = $1 AND user_id = $2',
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

/**
 * Returns true when the conversation has an active escalation mute window
 * (`escalated_until > NOW()`). When muted, the AI worker must skip generation
 * and outbound send entirely so the human operator can take over.
 */
async function isConversationEscalationMuted({ database = db, conversationId }) {
  if (!conversationId || !database?.isConfigured?.()) return false;
  try {
    const result = await database.query(
      `SELECT escalated_until
         FROM conversations
        WHERE id = $1
          AND escalated_until IS NOT NULL
          AND escalated_until > NOW()
        LIMIT 1`,
      [conversationId],
    );
    return result.rows.length > 0;
  } catch (_err) {
    // The escalated_until column is added by a migration; if it hasn't run yet
    // the query throws. Fail-open so we don't break message processing.
    return false;
  }
}

/**
 * Counts escalations recorded for this conversation in the last 24 hours and
 * returns the timestamp of the most recent one. Used to enforce a per-
 * conversation escalation cap and a minimum gap between escalations.
 */
async function getConversationEscalationStats({ database = db, conversationId }) {
  if (!conversationId || !database?.isConfigured?.()) {
    return { count24h: 0, lastSentAt: null };
  }
  const result = await database.query(
    `SELECT COUNT(*)::int AS n, MAX(sent_at) AS last_sent_at
       FROM escalation_log
      WHERE conversation_id = $1
        AND sent_at > NOW() - INTERVAL '24 hours'`,
    [conversationId],
  );
  const row = result.rows[0] || {};
  return {
    count24h: Number(row.n) || 0,
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
  };
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
  maxAgeMs = parseInt(process.env.AI_PENDING_MAX_AGE_MS || '1800000', 10),
}) {
  if (!conversationId || !userId) {
    return fallbackText ? [{ id: fallbackMessageId, content: fallbackText, raw_payload: {} }] : [];
  }

  // Age is bounded by the row's own `created_at` (DB insert time) — robust and
  // always present. We deliberately do NOT filter on raw_payload.timestamp
  // (the provider-supplied epoch): when it is missing or non-numeric the old
  // CASE evaluated to 0 and silently EXCLUDED the row, which made the worker
  // throw "AI job has empty inbound text" even though real messages existed.
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
     ORDER BY created_at ASC
     LIMIT $3`,
    [
      conversationId,
      userId,
      limit,
      Math.max(1, Number(maxAgeMs) || 1),
    ],
  );

  if (result.rows.length > 0) return result.rows;
  return [];
}

/**
 * Self-healing follow-up enqueue (FIX 1). The AI job key is a per-conversation
 * singleton (`conversation-<id>`), so a message that arrives while the job is
 * `active` is silently dropped by BullMQ (the re-add with the same jobId is a
 * no-op). After a job COMPLETES we re-check for inbound messages still pending
 * (created after the last assistant reply, status queued_for_ai), and if any
 * exist we enqueue a fresh debounced AI job so they are not stranded until the
 * 60s ai-recovery loop.
 *
 * Uses the same detection query as `loadPendingInboundMessages` (scoped by
 * user_id AND conversation_id). After a normal job all loaded messages are
 * marked `answered_by_ai`, so this returns 0 and nothing is enqueued — there
 * is no re-enqueue loop.
 */
async function enqueueFollowupIfPending({
  database = db,
  userId,
  conversationId,
  enqueue = enqueueAiReply,
  debounceMs = AI_REPLY_DEBOUNCE_MS,
} = {}) {
  if (!userId || !conversationId || !database?.isConfigured?.()) {
    return { enqueued: false, pending: 0 };
  }

  const pending = await loadPendingInboundMessages({
    database,
    userId,
    conversationId,
  });

  if (!pending.length) return { enqueued: false, pending: 0 };

  await enqueue(
    { userId, conversationId, source: 'followup' },
    { jobKey: `conversation-${conversationId}`, delay: debounceMs },
  );

  return { enqueued: true, pending: pending.length };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientDatabaseError(err) {
  const message = String(err?.message || err || '');
  return /not yet accepting connections|ECONNREFUSED|Connection terminated|connection timeout|timeout exceeded|ECONNRESET|57P03/i.test(message);
}

async function waitForDatabaseReady({
  database = db,
  timeoutMs = DB_READY_TIMEOUT_MS,
  intervalMs = DB_READY_INTERVAL_MS,
  logger = console,
} = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (typeof database.ping === 'function') return await database.ping();
      await database.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (!isTransientDatabaseError(err)) throw err;
      logger.warn?.('db', `PostgreSQL is not ready yet: ${err.message}`);
      await sleep(Math.max(1, Number(intervalMs) || 1));
    }
  }

  throw lastError || new Error('Timed out waiting for PostgreSQL');
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

async function storeAssistantMessage({ userId, conversationId, sender, reply, jobId, database = db }) {
  // provider_message_id must be unique per reply (the UNIQUE constraint is on
  // (user_id, provider_message_id)). The jobId is shared across all replies for
  // the same conversation (BullMQ uses conversation-${id} as the job key for
  // debouncing), so we add a UUID suffix to avoid duplicate key violations.
  const providerMessageId = `ai-worker:${jobId}:${crypto.randomUUID()}`;

  const result = await database.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'queued_for_send', $6::jsonb)
     RETURNING id`,
    [
      conversationId,
      userId,
      sender,
      reply,
      providerMessageId,
      JSON.stringify({ source: WORKER_NAME, jobId }),
    ],
  );

  await database.query(
    `UPDATE conversations
     SET last_message_at = NOW()
     WHERE id = $1`,
    [conversationId],
  );

  return result.rows[0].id;
}

async function markInboundMessagesQuotaExceeded({ database = db, messageIds = [], reason = 'empty' }) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length || !database.isConfigured?.()) return;
  await database.query(
    `UPDATE messages
     SET status = 'quota_exceeded',
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
     WHERE id = ANY($1::uuid[])`,
    [ids, JSON.stringify({ quotaExceededAt: new Date().toISOString(), reason })],
  );
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

/**
 * Send a canned keyword auto-reply (instant branch). Extracted so the
 * answered-marking invariant (FIX 2) is unit-testable without Redis/Postgres.
 * Deps are injectable; defaults bind to the module's real implementations.
 */
async function sendInstantAutoReply({
  job,
  payload = {},
  conversation,
  userId,
  instantReply,
  enrichedMessages = [],
  store = storeAssistantMessage,
  enqueueOutgoing = enqueueOutgoingWhatsapp,
  markAnswered = markInboundMessagesAnswered,
  setJobStatus = updateJobStatus,
}) {
  const replyMessageId = await store({
    userId,
    conversationId: conversation.id,
    sender: conversation.sender,
    reply: instantReply,
    jobId: job.id,
  });

  await enqueueOutgoing({
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

  // FIX 2: mark the inbound messages answered so ai-recovery does not
  // reprocess them (which previously threw on empty text and ended in a
  // confusing filler reply).
  await markAnswered({
    messageIds: enrichedMessages.map(message => message.id),
  });

  await setJobStatus(QUEUE_NAMES.aiReplies, job.id, {
    status: 'completed',
    finished_at: new Date(),
    attempts: job.attemptsMade + 1,
  });

  return { replyMessageId, queuedForSend: true, source: 'auto_reply_keyword' };
}

async function processAiReply(job) {
  const payload = job.data || {};
  const logger = createLogger(job.id);
  try {
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is required for AI worker');
    }

    const userId = payload.userId;
    if (!userId) throw new Error('Missing userId in AI job payload');

    await waitForDatabaseReady({ logger });

    await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
      status: 'processing',
      started_at: new Date(),
      attempts: job.attemptsMade,
    });

    const config = await resolveConfigForAI(userId);
    const conversation = await resolveConversation({
      userId,
      conversationId: payload.conversationId,
      sender: payload.sender,
    });
    if (!conversation) throw new Error('Unable to resolve conversation');

    // Escalation mute window: when a human has been pulled into the
    // conversation, we silence the bot for 30 minutes so the operator can
    // reply without the AI talking over them. We do not consume quota and we
    // do not send any outbound message.
    if (await isConversationEscalationMuted({ database: db, conversationId: conversation.id })) {
      logger.info('escalation', 'muted by escalation — skipping AI reply', {
        conversationId: conversation.id,
      });
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_escalation_muted',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
      });
      return { skipped: true, reason: 'escalation_muted' };
    }

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
      apiKey: config.openaiApiKey || '',
      logger,
    });
    let enrichedMessages = await enrichInboundMessagesWithMedia({
      messages: pendingMessages,
      analyzer: mediaAnalyzer,
      recordUsage: async (model, inputTokens, outputTokens) => {
        await recordAiUsage({ userId, model, inputTokens, outputTokens }).catch(() => {});
      },
    });
    let text = buildCombinedInboundText(enrichedMessages);

    if (!text.trim()) {
      // No loadable pending rows produced any text. Two cases:
      //  1) We still have the triggering message's text (fresh job) → answer it
      //     so a message is NEVER silently lost just because the batch query
      //     came back empty.
      //  2) Nothing at all (e.g. a recovery job for messages that already aged
      //     out) → expire quietly instead of throwing. The old throw caused
      //     BullMQ to retry 3× and then send a confusing "لحظات من فضلك" filler
      //     to a stale conversation, and left the rows stuck forever.
      const ft = String(fallbackText || '').trim();
      if (ft) {
        enrichedMessages = [{ id: payload.messageId, content: ft, raw_payload: {} }];
        text = ft;
      } else {
        if (payload.messageId) {
          await markInboundMessageFailed({
            messageId: payload.messageId,
            error: new Error('no pending inbound text (expired/stale job)'),
          }).catch(() => {});
        }
        await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
          status: 'skipped_empty_inbound',
          finished_at: new Date(),
          attempts: job.attemptsMade + 1,
        }).catch(() => {});
        logger.warn('ai', 'no pending inbound text — skipping (no retry, no filler)');
        return { skipped: true, reason: 'empty_inbound' };
      }
    }

    const quota = await checkMessageQuota(userId);
    if (!quota.canReply) {
      await markInboundMessagesQuotaExceeded({
        messageIds: enrichedMessages.map(m => m.id),
        reason: quota.reason,
      });
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_no_quota',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
        last_error: `quota ${quota.reason}`,
      });
      logger.warn('quota', `silent: ${userId} (${quota.reason}, ${quota.remaining} remaining)`);
      return { skipped: true, reason: quota.reason };
    }

    // Instant replies: when the message is ONLY a trigger (no extra question)
    // and it's a single message, send the canned reply directly (fast path).
    // When there's an extra question, prepend the canned reply verbatim and let
    // the AI answer the rest (combine mode).
    const { matched: instantMatched, hasExtraQuestion } = collectInstantReplies(config, text);
    const cannedPrefix = instantMatched.map(m => m.reply).join('\n');

    if (instantMatched.length && !hasExtraQuestion && enrichedMessages.length <= 1) {
      return await sendInstantAutoReply({
        job, payload, conversation, userId,
        instantReply: cannedPrefix,
        enrichedMessages,
      });
    }
    const combinePrefix = instantMatched.length ? cannedPrefix : '';

    const history = await buildHistoryForReply({
      database: db,
      conversationId: conversation.id,
      config,
      inboundText: text,
      userId,
    });

    // Customer profile (best-effort). Never blocks the reply: any failure
    // here is swallowed and we proceed without a profile.
    let customerProfile = null;
    try {
      customerProfile = await getCustomerProfile({ conversationId: conversation.id, database: db, userId });
    } catch (profileErr) {
      logger.warn('profile', `getProfile failed: ${profileErr.message}`);
    }

    const ai = new AIClient(config, logger, {
      record: async (model, inputTokens, outputTokens) => {
        await recordAiUsage({ userId, model, inputTokens, outputTokens }).catch(() => {});
      },
    });

    let reply;
    try {
      reply = String(await ai.getReply(history, { isFirstMsg: history.filter(m => m.role === 'assistant').length === 0, customerProfile, instantAnswered: combinePrefix }) || '').trim();
    } catch (aiErr) {
      if (combinePrefix) {
        logger.warn('ai-worker', `AI failed but sending canned prefix as fallback: ${aiErr.message}`);
        return await sendInstantAutoReply({ job, payload, conversation, userId, instantReply: combinePrefix, enrichedMessages });
      }
      throw aiErr;
    }
    if (!reply) throw new Error('AI returned empty reply');
    const escalation = prepareEscalation({
      reply,
      config,
      customerSender: conversation.sender,
      customerPhoneNumber: conversation.phone_number,
      inboundText: text,
    });
    let customerReply = escalation.customerReply.trim();
    if (!customerReply) throw new Error('AI returned empty customer reply after escalation marker cleanup');

    if (combinePrefix) {
      const aiPart = customerReply && customerReply !== combinePrefix ? `\n${customerReply}` : '';
      customerReply = `${combinePrefix}${aiPart}`.trim();
    }

    // Reply de-duplication: if the candidate reply is near-identical to one of
    // the last few assistant replies, regenerate once with higher penalties
    // and an extra system instruction. If the retry fails we still send the
    // original to avoid leaving the customer hanging.
    try {
      const dup = await findDuplicateRecentReply({
        db,
        conversationId: conversation.id,
        candidate: customerReply,
        lookback: 3,
        threshold: 0.85,
        userId,
      });
      if (dup) {
        logger.warn('dedup', 'duplicate assistant reply detected — regenerating', {
          similarity: Number(dup.similarity).toFixed(3),
        });
        const retryHistory = [
          ...history,
          { role: 'system', content: 'تجنّب صياغة آخر رد بالضبط، أعد بكلمات مختلفة.' },
        ];
        const retryRaw = await ai.getReply(retryHistory, {
          isFirstMsg: false,
          maxRetries: 1,
          presencePenalty: 0.9,
          frequencyPenalty: 0.6,
          customerProfile,
        }).catch(() => '');
        const retry = String(retryRaw || '').trim();
        if (retry) {
          const retryEscalation = prepareEscalation({
            reply: retry,
            config,
            customerSender: conversation.sender,
            customerPhoneNumber: conversation.phone_number,
            inboundText: text,
          });
          const retryCustomer = (retryEscalation.customerReply || '').trim();
          if (retryCustomer) customerReply = retryCustomer;
        }
      }
    } catch (dedupErr) {
      logger.warn('dedup', `dedup check failed: ${dedupErr.message}`);
    }

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
      const contactTarget = escalation.ownerMessage.contactTarget || escalation.ownerMessage.sender;
      const cooldown = await db.query(
        `SELECT 1 FROM escalation_log
         WHERE user_id = $1 AND conversation_id = $2 AND contact_target = $3 AND sent_at > NOW() - INTERVAL '30 minutes'
         LIMIT 1`,
        [userId, conversation.id, contactTarget],
      );

      // Per-conversation cap: at most 3 escalations / 24h, and a 10-minute
      // gap between any two escalations on the same conversation. This guards
      // against AI loops dragging the owner into noise.
      const escStats = await getConversationEscalationStats({
        database: db,
        conversationId: conversation.id,
      });
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const lastSentMs = escStats.lastSentAt ? escStats.lastSentAt.getTime() : 0;
      const overCap = escStats.count24h >= 3;
      const tooSoon = escStats.count24h >= 1 && lastSentMs > tenMinAgo;

      if (cooldown.rowCount > 0) {
        console.warn(
          `${new Date().toISOString()} [${WORKER_NAME}] skipping escalation — cooldown active for user=${userId} conversation=${conversation.id} target=${contactTarget}`,
        );
      } else if (overCap || tooSoon) {
        logger.warn('escalation', 'escalation suppressed by per-conversation cap', {
          conversationId: conversation.id,
          count24h: escStats.count24h,
          reason: overCap ? 'cap_24h_reached' : 'min_gap_not_elapsed',
        });
      } else {
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
          customerPhoneNumber: conversation.phone_number,
        }, {
          jobKey: buildEscalationJobKey(replyMessageId),
        });

        await db.query(
          `INSERT INTO escalation_log (user_id, conversation_id, contact_target) VALUES ($1, $2, $3)`,
          [userId, conversation.id, contactTarget],
        );

        // Mute the bot for 30 minutes so the human operator can take over
        // without the AI talking on top. Failures here are non-fatal — we
        // already enqueued the escalation, the mute is a nicety.
        try {
          await db.query(
            `UPDATE conversations
                SET escalated_until = NOW() + INTERVAL '30 minutes'
              WHERE id = $1`,
            [conversation.id],
          );
        } catch (muteErr) {
          logger.warn('escalation', `failed to set escalated_until: ${muteErr.message}`);
        }
      }
    }

    await markInboundMessagesAnswered({
      messageIds: enrichedMessages.map(message => message.id),
    });

    // Fire-and-forget profile extraction. Never awaited, never throws — the
    // helper schedules a setImmediate and swallows every error internally.
    try {
      extractCustomerProfileAsync({
        conversationId: conversation.id,
        userId,
        customerText: text,
      });
    } catch (_profileErr) {
      // defensive: extractAsync itself shouldn't throw, but we guard anyway.
    }

    await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
      status: 'completed',
      finished_at: new Date(),
      attempts: job.attemptsMade + 1,
    });

    return { replyMessageId, queuedForSend: true };
  } catch (err) {
    await markInboundMessageFailed({ messageId: payload.messageId, error: err }).catch(() => {});

    // Final-attempt fallback: when BullMQ has exhausted its retries we send a
    // brief reassurance message so the customer isn't left in silence. We
    // mark the job completed (return instead of throw) so BullMQ does not
    // retry — and the deterministic jobKey makes the enqueue idempotent.
    const attempts = Number(job?.attemptsMade) || 0;
    const isFinalAttempt = attempts >= 2;
    if (isFinalAttempt) {
      try {
        const config = await resolveConfigForAI(payload.userId).catch(() => ({}));
        const fallbackText =
          (config && config.fallbackMessage) ||
          'لحظات من فضلك، نراجع طلبك ونرجعلك بأقرب وقت 🌷';
        const sender = payload.sender || null;
        const fallbackKey = `fallback:${payload.messageId || job?.id || crypto.randomUUID()}`;

        await enqueueOutgoingWhatsapp({
          userId: payload.userId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          providerMessageId: payload.providerMessageId,
          sender,
          reply: fallbackText,
          source: 'ai_failure_fallback',
        }, {
          jobKey: fallbackKey,
        });

        logger.warn('fallback', 'AI exhausted retries — sent ai_failure_fallback', {
          attempts,
          error: err?.message,
        });

        // Best-effort owner notification. The notify service exposes only an
        // SMTP mailer today; if SMTP isn't configured we silently no-op.
        try {
          const { createMailer } = require('../services/notify/mailer');
          const mailer = createMailer();
          const ownerEmail = process.env.OWNER_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL;
          if (mailer && ownerEmail) {
            await mailer.sendMail({
              to: ownerEmail,
              subject: 'AI worker exhausted retries — fallback sent',
              text: `userId=${payload.userId}\nconversationId=${payload.conversationId}\nmessageId=${payload.messageId}\nerror=${err?.message || err}`,
            }).catch(() => {});
          }
        } catch (_notifyErr) {
          // notify is best-effort
        }

        await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
          status: 'completed_with_fallback',
          finished_at: new Date(),
          attempts: attempts + 1,
          last_error: err?.message || String(err),
        }).catch(() => {});

        return { fallbackSent: true, source: 'ai_failure_fallback' };
      } catch (fallbackErr) {
        logger.error('fallback', `fallback send failed: ${fallbackErr.message}`);
        // fall through to throw so BullMQ records the failure
      }
    }

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
  await waitForDatabaseReady({
    logger: {
      warn: (stage, message) => console.warn(`${new Date().toISOString()} [${WORKER_NAME}] [${stage}] ${message}`),
      info: (stage, message) => console.log(`${new Date().toISOString()} [${WORKER_NAME}] [${stage}] ${message}`),
    },
  });

  const worker = createWorker();

  worker.on('completed', async (job, returnvalue) => {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] completed ${job.id}`);
    // Self-healing follow-up (FIX 1): a message that arrived while this job was
    // `active` would otherwise be stranded (singleton jobId no-op). The job is
    // in `completed` state here, so a fresh enqueue's ensureReusableQueueJobId
    // will remove it and the add will succeed. Never crash the worker.
    //
    // Skip the follow-up when the job SKIPPED work (escalation mute / no quota):
    // those paths intentionally leave the inbound rows `queued_for_ai` without
    // answering them, so re-enqueueing here would spin a tight loop for the
    // whole mute window. The slower ai-recovery loop (60s) still reprocesses
    // them once the skip condition clears.
    if (returnvalue && returnvalue.skipped) return;
    try {
      const data = job?.data || {};
      const result = await enqueueFollowupIfPending({
        userId: data.userId,
        conversationId: data.conversationId,
      });
      if (result.enqueued) {
        console.log(
          `${new Date().toISOString()} [${WORKER_NAME}] re-enqueued follow-up for conversation=${data.conversationId} (${result.pending} pending)`,
        );
      }
    } catch (err) {
      console.warn(
        `${new Date().toISOString()} [${WORKER_NAME}] follow-up enqueue failed for ${job?.id}: ${err.message}`,
      );
    }
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
  enqueueFollowupIfPending,
  enrichInboundMessagesWithMedia,
  sendInstantAutoReply,
  getConversationEscalationStats,
  isConversationEscalationMuted,
  isTransientDatabaseError,
  loadPendingInboundMessages,
  markInboundMessageFailed,
  markInboundMessagesAnswered,
  markInboundMessagesQuotaExceeded,
  storeAssistantMessage,
  processAiReply,
  waitForDatabaseReady,
};
