'use strict';

// Install libsignal log throttle FIRST, before any require that might transitively
// load Baileys/libsignal. Without this each Bad MAC error prints a 5-line stack
// to stderr, flooding Railway's log rate-limit. Explicit install() — no
// self-install at require time.
require('../runtime/libsignal-log-throttle').install();
require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingWhatsapp, enqueueAiReply, resolveDebounceMs } = require('../queues/message-queue');
const { buildEscalationJobKey } = require('../queues/outgoing-job-key');
const AIClient = require('../../lib/ai-client');
const { DEFAULT_CONFIG, MODEL_PRICES } = require('../../lib/constants');
const { buildHistoryForReply } = require('./ai-history');
const { prepareEscalation } = require('./escalation-routing');
const { findDuplicateRecentReply, similarity: replySimilarity } = require('./reply-deduplication');
const { getProfile: getCustomerProfile, extractAsync: extractCustomerProfileAsync } = require('./profile-extractor');
const { resolveReplyDelayMs } = require('./reply-delay');
const { findAutoReply, collectInstantReplies, combineCannedAndAi } = require('../services/bot/platform-features');
const { resolveConfigForAI } = require('../services/bot/runtime-bot');
const { loadActiveLearnedReplies } = require('../services/learning/owner-reply-learner');
const { checkMessageQuota } = require('../services/billing/message-quota');
const { getPlatformSetting } = require('../services/platform/platform-settings');
const { installProcessSafetyNet } = require('../runtime/process-safety');
const { customerRequestedEscalation } = require('../services/ai/reply-validator');
const { compactQualityGateAudit } = require('../services/ai/reply-quality-gate');
const { buildCustomerUpdateText } = require('../services/escalation/escalation-bridge');
const { isOriginalMessageStale } = require('../../lib/message-staleness');
const {
  OpenAIMediaAnalyzer,
  buildMediaAnalysisText,
} = require('../services/ai/openai-media-analysis');

const WORKER_NAME = 'ai-worker';
const CONCURRENCY = parseInt(process.env.AI_WORKER_CONCURRENCY || '4', 10);
const RATE_LIMIT_MAX = parseInt(process.env.AI_WORKER_RATE_LIMIT_MAX || '15', 10);
const RATE_LIMIT_DURATION_MS = parseInt(process.env.AI_WORKER_RATE_LIMIT_DURATION_MS || '60000', 10);
const DB_READY_TIMEOUT_MS = parseInt(process.env.AI_WORKER_DB_READY_TIMEOUT_MS || '120000', 10);
const DB_READY_INTERVAL_MS = parseInt(process.env.AI_WORKER_DB_READY_INTERVAL_MS || '2000', 10);
// Must outlive the worst-case ai-client retry chain (30s timeout × 3 attempts
// + 429 backoff waits ≈ 150s). message-queue.js derives its stale-active
// cleanup threshold from the same env var (×2) — keep the defaults in sync.
const LOCK_DURATION_MS = parseInt(process.env.AI_WORKER_LOCK_DURATION_MS || '180000', 10);

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

/**
 * Does this conversation have an escalation that was sent to the team but the
 * team has NOT answered yet (escalation_threads.resolved_at IS NULL)? When true,
 * the customer's request is already on record "awaiting the team", so the AI must
 * stop re-registering it ("بسجل طلبك / بيتواصل معك الفريق") on every follow-up —
 * the production bug where the bot looped the same escalation promise for days
 * because nothing ever told it the escalation already happened. The thread is
 * cleared (resolved_at set) the moment the team's answer is relayed back, so the
 * bot resumes normal handling automatically. A 7-day window keeps an ancient,
 * never-resolved thread from silencing the bot on a genuinely new issue.
 */
async function getPendingEscalation({ database = db, conversationId }) {
  if (!conversationId || !database?.isConfigured?.()) {
    return { pending: false, since: null };
  }
  const result = await database.query(
    `SELECT created_at
       FROM escalation_threads
      WHERE conversation_id = $1
        AND resolved_at IS NULL
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 1`,
    [conversationId],
  );
  const row = result.rows[0];
  return {
    pending: Boolean(row),
    since: row?.created_at ? new Date(row.created_at) : null,
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
  debounceMs = resolveDebounceMs(),
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
    'هذه رسائل متتالية من نفس العميل. افهم نيته الكاملة منها مجتمعةً وردّ برد واحد متماسك يجاوب على كل ما سأل عنه بدون أن تترك أي سؤال، دون أن تكرر أو تتناقض:',
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

// Retire every still-queued inbound message on a muted conversation so the bot
// NEVER answers messages a customer sent while a human was handling the chat —
// not even after the mute window expires. Without this the messages stay
// 'queued_for_ai' and ai-recovery would re-enqueue + answer them once the pause
// lifts (owner report 2026-06-13). Returns the number retired.
async function markConversationMessagesMutedSkipped({ database = db, userId, conversationId }) {
  if (!conversationId || !database.isConfigured?.()) return { retired: 0 };
  const result = await database.query(
    `UPDATE messages
        SET status = 'skipped_escalation_muted',
            raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
      WHERE user_id = $1 AND conversation_id = $2
        AND direction = 'inbound' AND status = 'queued_for_ai'`,
    [userId, conversationId, JSON.stringify({ mutedSkippedAt: new Date().toISOString() })],
  );
  return { retired: result.rowCount || 0 };
}

async function storeAssistantMessage({ userId, conversationId, sender, reply, jobId, qualityGateAudit, database = db }) {
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
      JSON.stringify({
        source: WORKER_NAME,
        jobId,
        qualityGate: compactQualityGateAudit(qualityGateAudit),
      }),
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

// Once-per-conversation guard for the platform quota-stop notice. Looks for an
// outbound row in THIS conversation already tagged raw_payload.kind = 'quota_stop'.
async function quotaStopNoticeAlreadySent({ database = db, userId, conversationId }) {
  if (!conversationId || !database.isConfigured?.()) return false;
  const r = await database.query(
    `SELECT 1 FROM messages
      WHERE user_id = $1 AND conversation_id = $2
        AND direction = 'outbound'
        AND raw_payload->>'kind' = 'quota_stop'
      LIMIT 1`,
    [userId, conversationId],
  );
  return (r.rowCount || 0) > 0;
}

// Persist a quota-stop system notice, tagged kind=quota_stop so the
// once-per-conversation guard above can detect it. Mirrors storeAssistantMessage
// but writes the system-notice tag instead of the normal source payload.
//
// The INSERT uses the partial unique index uniq_quota_stop_notice_per_conversation
// as a conflict arbiter (ON CONFLICT DO NOTHING). This makes "at most one
// quota_stop per (user, conversation)" an ATOMIC DB guarantee — two concurrent
// ai-jobs (recovery re-enqueue / BullMQ retry) cannot both insert. Returns the
// new id when this call won the insert, or null when a row already existed
// (conflict → no row returned). The caller enqueues the outgoing notice ONLY
// when a non-null id is returned, so the DB decides who sends.
async function storeQuotaStopNotice({ database = db, userId, conversationId, sender, text, jobId }) {
  const providerMessageId = `ai-worker:quota_stop:${jobId}:${crypto.randomUUID()}`;
  const result = await database.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'queued_for_send', $6::jsonb)
     ON CONFLICT (user_id, conversation_id) WHERE (raw_payload->>'kind') = 'quota_stop' DO NOTHING
     RETURNING id`,
    [
      conversationId,
      userId,
      sender,
      text,
      providerMessageId,
      JSON.stringify({ source: WORKER_NAME, jobId, kind: 'quota_stop', systemNotice: true }),
    ],
  );
  return result.rows[0]?.id ?? null;
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
// Which of the batched inbound messages does the canned prefix actually
// answer? Only those may be marked answered when we fall back to canned-only
// (AI failure) — marking the OTHERS buried real customer questions with no
// reply, no escalation and no retry (production 2026-06-11, conv d8618a0a).
// The escalation notification used to carry only the TRIGGER message ("طيب
// وش الحل ؟") — the actual problem stated earlier was lost (production
// 2026-06-12 16:13). Join the last few customer turns so the team reads the
// whole picture.
function recentCustomerContext(history = [], fallback = '', limit = 3) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m?.role === 'user')
    .map(m => String(m.content || '').trim())
    .filter(Boolean);
  const recent = turns.slice(-limit);
  return recent.length ? recent.join('\n') : String(fallback || '');
}

function messagesCoveredByTriggers(messages = [], matched = []) {
  if (!matched.length) return [];
  const keywords = matched.map(m => String(m.keyword || '').toLowerCase()).filter(Boolean);
  return messages.filter((message) => {
    const content = String(message?.content || '').toLowerCase();
    return content && keywords.some(k => content.includes(k));
  });
}

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
    preSendReviewRequired: true,
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
  // Tracks whether a real customer reply was already enqueued — guards the
  // final-attempt fallback from sending "لحظات من فضلك" ON TOP of a real reply.
  let outgoingEnqueued = false;
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
    // Phase-1 self-learning: attach Q→A pairs harvested from the owner's own
    // manual replies. Per-merchant kill-switch (config.learningEnabled, default
    // ON). Fail-open ([]) — learning must never block a reply.
    config.learnedReplies = (config.learningEnabled === false)
      ? []
      : await loadActiveLearnedReplies({ userId }).catch(() => []);
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
      // Retire the messages received during the human-handover window so they
      // are NOT answered after the mute lifts (the human is handling them).
      // Otherwise they linger as 'queued_for_ai' and ai-recovery re-answers them
      // once the pause expires.
      const retired = await markConversationMessagesMutedSkipped({
        database: db, userId, conversationId: conversation.id,
      }).catch((e) => { logger.warn('escalation', `failed to retire muted messages: ${e.message}`); return { retired: 0 }; });
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_escalation_muted',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
      });
      return { skipped: true, reason: 'escalation_muted', retired: retired?.retired || 0 };
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

    // LAYER 2 of the staleness guard (independent of Layer 1 at ingest). Even
    // if an old message slipped past ingest, re-validate the ORIGINAL WhatsApp
    // send-time here — the DB `created_at` is the insert time and looks fresh,
    // so we must check raw_payload.timestamp. If EVERY pending message is older
    // than the policy, retire them and never reply (the customer has long since
    // moved on). Fail-open: messages with no/invalid timestamp count as fresh.
    if (pendingMessages.length > 0
        && pendingMessages.every(m => isOriginalMessageStale(m?.raw_payload?.timestamp))) {
      // Retire them as ai_failed (terminal — recovery only re-picks
      // queued_for_ai) so they leave the stuck count and are never answered.
      await db.query(
        `UPDATE messages SET status = 'ai_failed',
                raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
          WHERE id = ANY($1::uuid[])`,
        [pendingMessages.map(m => m.id), JSON.stringify({ retiredAt: new Date().toISOString(), reason: 'stale_message' })],
      ).catch(() => {});
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_stale',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
        last_error: 'all pending messages older than the staleness policy',
      });
      logger.warn('staleness', 'skipped — every pending message is older than the policy (no reply to an old conversation)', {
        conversationId: conversation.id,
      });
      return { skipped: true, reason: 'stale_message' };
    }

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
      // Platform quota-stop notice: when the admin has enabled a stop message,
      // tell the customer ONCE per conversation that auto-replies are paused,
      // then stay silent. Wrapped so any failure here can NEVER break the
      // existing silent path. The text comes ONLY from the platform setting.
      try {
        const stop = await getPlatformSetting('quotaStopMessage', { database: db });
        const stopText = String(stop?.text || '').trim();
        if (stop?.enabled && stopText) {
          // Fast-path: skip the insert attempt if a notice is already visible.
          // This is only an optimization — the ON CONFLICT inside
          // storeQuotaStopNotice is the REAL atomic guard, so two concurrent
          // jobs that both pass this SELECT still cannot double-insert.
          const already = await quotaStopNoticeAlreadySent({
            database: db, userId, conversationId: conversation.id,
          });
          if (!already) {
            const noticeId = await storeQuotaStopNotice({
              database: db,
              userId,
              conversationId: conversation.id,
              sender: conversation.sender,
              text: stopText,
              jobId: job.id,
            });
            // Enqueue ONLY when WE won the atomic insert (non-null id). On a
            // conflict the row already existed (another job sent it) and
            // noticeId is null → stay silent, no double-send.
            if (noticeId) {
              await enqueueOutgoingWhatsapp({
                userId,
                conversationId: conversation.id,
                messageId: payload.messageId,
                providerMessageId: payload.providerMessageId,
                replyMessageId: noticeId,
                sender: conversation.sender,
                reply: stopText,
                // Exempts this notice from the outgoing quota gate AND from the
                // quota decrement (balance is 0; this is a system notice, not a
                // billable reply). Owner-pause still applies.
                systemNotice: true,
                kind: 'quota_stop',
              }, {
                jobKey: String(noticeId),
              });
              logger.warn('quota', `quota-stop notice enqueued once: ${userId} conv=${conversation.id}`);
            }
          }
        }
      } catch (noticeErr) {
        logger.warn('quota', `quota-stop notice failed (silent path preserved): ${noticeErr.message}`);
      }

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

    // Escalation state (best-effort). When the team was already notified and
    // hasn't answered yet, tell the model so it stops re-registering the request
    // on every follow-up ("بسجل طلبك / بيتواصل معك الفريق").
    let escalationPending = false;
    try {
      const pending = await getPendingEscalation({ database: db, conversationId: conversation.id });
      escalationPending = pending.pending;
    } catch (pendingErr) {
      logger.warn('escalation', `pending-escalation check failed: ${pendingErr.message}`);
    }

    const ai = new AIClient(config, logger, {
      record: async (model, inputTokens, outputTokens) => {
        await recordAiUsage({ userId, model, inputTokens, outputTokens }).catch(() => {});
      },
    });

    let reply;
    try {
      reply = String(await ai.getReply(history, { isFirstMsg: history.filter(m => m.role === 'assistant').length === 0, customerProfile, instantAnswered: combinePrefix, escalationPending }) || '').trim();
    } catch (aiErr) {
      if (combinePrefix) {
        // Send the canned part now, but ONLY mark the trigger messages as
        // answered — the customer's real questions stay queued_for_ai so the
        // follow-up/recovery retries them (and the retry won't re-match the
        // greeting because its message is already answered).
        logger.warn('ai-worker', `AI failed but sending canned prefix as fallback: ${aiErr.message}`);
        return await sendInstantAutoReply({
          job, payload, conversation, userId,
          instantReply: combinePrefix,
          enrichedMessages: messagesCoveredByTriggers(enrichedMessages, instantMatched),
        });
      }
      throw aiErr;
    }
    if (!reply) throw new Error('AI returned empty reply');
    const escalation = prepareEscalation({
      reply,
      config,
      customerSender: conversation.sender,
      customerPhoneNumber: conversation.phone_number,
      inboundText: recentCustomerContext(history, text),
    });
    let customerReply = escalation.customerReply.trim();
    if (!customerReply) throw new Error('AI returned empty customer reply after escalation marker cleanup');

    if (combinePrefix) {
      customerReply = combineCannedAndAi(combinePrefix, customerReply);
    }

    // Reply de-duplication: if the candidate reply is near-identical to one of
    // the last few assistant replies, regenerate once with higher penalties and
    // an extra system instruction. If the regenerated reply is STILL a
    // near-duplicate (or the retry failed), we SUPPRESS it rather than sending a
    // second, differently-worded copy of the same answer — that is the Issue-1
    // duplicate the customer used to see. The inbound is still marked answered so
    // neither the follow-up nor ai-recovery regenerates yet another duplicate.
    let suppressDuplicate = false;
    try {
      const dup = await findDuplicateRecentReply({
        db,
        conversationId: conversation.id,
        candidate: customerReply,
        lookback: 6,
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
          instantAnswered: combinePrefix,
          escalationPending,
        }).catch(() => '');
        const retry = String(retryRaw || '').trim();
        let regenerated = null;
        if (retry) {
          const retryEscalation = prepareEscalation({
            reply: retry,
            config,
            customerSender: conversation.sender,
            customerPhoneNumber: conversation.phone_number,
            inboundText: text,
          });
          let retryCustomer = (retryEscalation.customerReply || '').trim();
          if (retryCustomer) {
            if (combinePrefix) {
              retryCustomer = combineCannedAndAi(combinePrefix, retryCustomer);
            }
            regenerated = retryCustomer;
          }
        }

        // Re-check the OUTCOME against the matched reply. If regeneration
        // produced a genuinely different reply, send it. Otherwise (retry empty
        // OR still ≥ threshold similar to the duplicate) suppress entirely.
        const candidateAfterRetry = regenerated || customerReply;
        const stillDuplicate = replySimilarity(candidateAfterRetry, dup.content) >= 0.85;
        if (regenerated && !stillDuplicate) {
          customerReply = regenerated;
        } else {
          suppressDuplicate = true;
        }
      }
    } catch (dedupErr) {
      logger.warn('dedup', `dedup check failed: ${dedupErr.message}`);
    }

    if (suppressDuplicate) {
      // Mark the inbound answered so the just-sent earlier reply stands and no
      // retry/recovery/follow-up regenerates another near-duplicate. No outbound
      // is enqueued; the completed-handler skips follow-up on a skipped result.
      await markInboundMessagesAnswered({
        messageIds: enrichedMessages.map(message => message.id),
      });
      await updateJobStatus(QUEUE_NAMES.aiReplies, job.id, {
        status: 'skipped_duplicate',
        finished_at: new Date(),
        attempts: job.attemptsMade + 1,
      });
      logger.warn('dedup', 'near-duplicate reply suppressed (not sent) after failed regeneration');
      return { skipped: true, reason: 'duplicate_suppressed' };
    }

    const replyMessageId = await storeAssistantMessage({
      userId,
      conversationId: conversation.id,
      sender: conversation.sender,
      reply: customerReply,
      jobId: job.id,
      qualityGateAudit: ai.lastDebug?.qualityGate,
    });
    const replyDelayMs = resolveReplyDelayMs(config);

    // B1 (anti-duplicate): mark the inbound answered BEFORE enqueue. If the
    // worker is killed (deploy/SIGTERM), loses its BullMQ lock, or the enqueue
    // throws, the inbound must NOT stay 'queued_for_ai' — otherwise a retry or
    // ai-recovery regenerates a SECOND reply with a fresh replyMessageId that
    // escapes the per-replyMessageId dedup guard (the production duplicate).
    await markInboundMessagesAnswered({
      messageIds: enrichedMessages.map(message => message.id),
    });

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
      source: 'ai_reply',
      preSendReviewRequired: true,
    }, {
      jobKey: String(replyMessageId),
      delay: replyDelayMs,
    });
    outgoingEnqueued = true;

    // The escalation forwarding below is a best-effort SIDE CHANNEL — wrapped so
    // a failure can never throw the job and trigger a customer re-send.
    try {
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
      // Re-escalation cap is per-merchant configurable (0 = unlimited). The bot
      // can escalate AGAIN on a new issue, not just once.
      const maxEsc = parseInt(config.maxEscalationsPerConversation, 10);
      const effectiveMaxEsc = Number.isFinite(maxEsc) ? maxEsc : 5;
      const overCap = effectiveMaxEsc > 0 && escStats.count24h >= effectiveMaxEsc;
      let tooSoon = escStats.count24h >= 1 && lastSentMs > tenMinAgo;

      // The customer EXPLICITLY asked to reach the team ("ارسل للادارة مرة
      // ثانية") — production 2026-06-12: the bot promised and the anti-noise
      // guards silently ate it. An explicit request bypasses the cooldown and
      // the 10-minute gap; the 3/24h cap stays as the hard spam ceiling.
      const explicitRequest = customerRequestedEscalation(text);
      if (explicitRequest && !overCap) {
        cooldown.rowCount = 0;
        tooSoon = false;
        logger.info('escalation', 'explicit customer request — bypassing cooldown/min-gap');
      }

      if (cooldown.rowCount > 0 || tooSoon || overCap) {
        // NO suppression is ever silent (production 2026-06-12 21:42: the
        // 3/24h cap swallowed the 4th escalation while the customer was told
        // "رسلت للإدارة" — the owner only found out from the angry customer).
        // Every guard routes to a light "🔁 تحديث" on the SAME team target.
        logger.warn('escalation', 'suppressed full escalation — forwarding a customer UPDATE instead', {
          conversationId: conversation.id,
          reason: cooldown.rowCount > 0 ? 'cooldown_30m' : (overCap ? 'cap_24h_reached' : 'min_gap_10m'),
          count24h: escStats.count24h,
        });
        await enqueueOutgoingWhatsapp({
          userId,
          conversationId: conversation.id,
          sender: escalation.ownerMessage.sender,
          reply: buildCustomerUpdateText({ customerSender: conversation.sender, text }),
          escalation: true,
          customerSender: conversation.sender,
          customerPhoneNumber: conversation.phone_number,
        }, {
          jobKey: `esc-update-${replyMessageId}`,
          delay: 0,
        }).catch((err) => logger.warn('escalation', `update forward failed: ${err.message}`));
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

        // Pause the bot after escalation ONLY if the merchant enabled it
        // (default OFF). Default behavior now: the bot KEEPS HELPING after an
        // escalation so the customer is never stranded when no human picks up.
        // When enabled, the pause duration is configurable (default 5 min).
        if (config.escalationPausesBot === true) {
          const pm = parseInt(config.escalationPauseMinutes, 10);
          const pauseMin = Number.isFinite(pm) && pm > 0 ? pm : 5;
          try {
            await db.query(
              `UPDATE conversations
                  SET escalated_until = NOW() + ($2 * INTERVAL '1 minute')
                WHERE id = $1`,
              [conversation.id, pauseMin],
            );
          } catch (muteErr) {
            logger.warn('escalation', `failed to set escalated_until: ${muteErr.message}`);
          }
        }
      }
    }
    } catch (escErr) {
      // CX-2: the customer reply was already enqueued and the inbound already
      // marked answered above, so a failure in the escalation side-channel must
      // NOT throw (a retry would re-send a SECOND customer reply).
      logger.warn('escalation', `escalation side-channel failed (customer already answered): ${escErr.message}`);
    }

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
    // Anti-duplicate (Path 3): never send the fallback ON TOP of a real reply
    // that was already enqueued this run — that produced "real reply + لحظات من فضلك".
    if (isFinalAttempt && !outgoingEnqueued) {
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
          preSendReviewRequired: true,
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
    lockDuration: LOCK_DURATION_MS,
  });
}

async function main() {
  installProcessSafetyNet({ processName: WORKER_NAME });
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
      // Use the SAME per-merchant grouping window for the follow-up re-enqueue
      // as the initial ingest. Load the config cheaply with fail-open: a missing
      // config falls back to the global default debounce.
      const followupCfg = await resolveConfigForAI(data.userId).catch(() => ({}));
      const result = await enqueueFollowupIfPending({
        userId: data.userId,
        conversationId: data.conversationId,
        debounceMs: resolveDebounceMs(followupCfg),
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
  CONCURRENCY,
  LOCK_DURATION_MS,
  buildCombinedInboundText,
  createWorker,
  enqueueFollowupIfPending,
  enrichInboundMessagesWithMedia,
  sendInstantAutoReply,
  getConversationEscalationStats,
  getPendingEscalation,
  isConversationEscalationMuted,
  isTransientDatabaseError,
  loadPendingInboundMessages,
  markInboundMessageFailed,
  markInboundMessagesAnswered,
  markConversationMessagesMutedSkipped,
  messagesCoveredByTriggers,
  markInboundMessagesQuotaExceeded,
  recentCustomerContext,
  storeAssistantMessage,
  processAiReply,
  waitForDatabaseReady,
};
