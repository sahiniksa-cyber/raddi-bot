'use strict';

require('dotenv').config({ quiet: true });

/**
 * Instagram worker process. Runs TWO BullMQ workers in one process:
 *   - incoming-instagram: generate an AI reply (reusing the shared AIClient
 *     brain + the merchant's Instagram behavior config) and enqueue the send.
 *   - outgoing-instagram: quota-gate, send via Graph API, then decrement the
 *     SHARED billing quota (same checkMessageQuota/decrementMessageQuota as
 *     WhatsApp — so every Instagram reply costs one message from the same
 *     balance).
 *
 * ISOLATION: gated behind INSTAGRAM_ENABLED (default off). Never imports
 * Baileys or any WhatsApp worker. A crash here cannot affect WhatsApp.
 */

const { Worker } = require('bullmq');
const crypto = require('node:crypto');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingInstagram } = require('../queues/instagram-queue');
const db = require('../db/client');
const AIClient = require('../../lib/ai-client');
const { resolveInstagramConfig } = require('../services/instagram/instagram-config');
const { buildInstagramHistory } = require('../services/instagram/instagram-history');
const { getAccountToken } = require('../services/instagram/instagram-accounts');
const { sendDirectMessage } = require('../services/instagram/instagram-graph');
const { checkMessageQuota, decrementMessageQuota } = require('../services/billing/message-quota');
const { logInstagram } = require('../services/instagram/instagram-logs');
const { resolveConfigForAI } = require('../services/bot/runtime-bot');
const { stripEscalationMarkers } = require('./escalation-routing');

const WORKER_NAME = 'instagram-worker';

// ── Pure, unit-tested decision helpers ──────────────────────────────────────
function shouldGenerateReply(igSettings) {
  return Boolean(igSettings && igSettings.enabled === true);
}

function shouldBlockSendForQuota(quota) {
  return Boolean(quota && quota.canReply === false);
}

// Idempotency: if this reply row is already sent (or has a provider id), a
// BullMQ retry must NOT re-send it or decrement the shared quota again.
function alreadySent(row) {
  return Boolean(row && (row.status === 'sent' || row.status === 'sending' || row.provider_message_id));
}

function buildReplyKey(userId, conversationId, messageIds) {
  const material = [userId, conversationId, ...messageIds.map(String).sort()].join(':');
  return `ig-ai:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/**
 * Merge the merchant's Instagram behavior config with the shared resolved
 * API keys (Instagram config is stored WITHOUT keys, so keys come from
 * resolveConfigForAI). Instagram behavior always wins; model falls back to the
 * resolved model when the Instagram config doesn't set one.
 */
function buildAiConfig(igConfig, resolved) {
  return {
    ...igConfig,
    openaiApiKey: resolved.openaiApiKey,
    openrouterApiKey: resolved.openrouterApiKey,
    googleApiKey: resolved.googleApiKey,
    anthropicApiKey: resolved.anthropicApiKey,
    model: igConfig.model || resolved.model,
  };
}

function createLogger(jobId) {
  const prefix = `[${WORKER_NAME}:${jobId || 'manual'}]`;
  const write = (level, stage, message) => {
    const line = `${new Date().toISOString()} ${prefix} [${level}] [${stage}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (stage, message) => write('info', stage, message),
    warn: (stage, message) => write('warn', stage, message),
    error: (stage, message) => write('error', stage, message),
  };
}

// ── Incoming: generate an AI reply and enqueue it for sending ───────────────
async function processIncoming(job, deps = {}) {
  const database = deps.database || db;
  const resolveSettings = deps.resolveInstagramConfig || resolveInstagramConfig;
  const buildHistory = deps.buildInstagramHistory || buildInstagramHistory;
  const resolveKeys = deps.resolveConfigForAI || resolveConfigForAI;
  const AI = deps.AIClient || AIClient;
  const quotaCheck = deps.checkMessageQuota || checkMessageQuota;
  const enqueueOutgoing = deps.enqueueOutgoingInstagram || enqueueOutgoingInstagram;
  const { userId, conversationId, participantId } = job.data;
  const pending = await database.query(
    `SELECT id FROM instagram_messages
      WHERE conversation_id=$1 AND user_id=$2 AND direction='inbound' AND status='queued_for_ai'
      ORDER BY created_at ASC`,
    [conversationId, userId],
  );
  const pendingIds = pending.rows.map((row) => row.id);
  if (!pendingIds.length) return { skipped: 'no_pending_inbound' };

  const igSettings = await resolveSettings(userId);
  if (!shouldGenerateReply(igSettings)) {
    await database.query(
      `UPDATE instagram_messages SET status='ai_disabled' WHERE id = ANY($1::uuid[]) AND user_id=$2`,
      [pendingIds, userId],
    );
    return { skipped: 'ai_disabled' };
  }

  const quota = await quotaCheck(userId);
  if (shouldBlockSendForQuota(quota)) {
    await database.query(
      `UPDATE instagram_messages SET status='quota_stop' WHERE id = ANY($1::uuid[]) AND user_id=$2`,
      [pendingIds, userId],
    );
    return { skipped: 'quota_empty' };
  }

  const history = await buildHistory(conversationId, userId, igSettings.config);
  if (!history.length) return { skipped: 'empty_history' };

  const replyKey = buildReplyKey(userId, conversationId, pendingIds);
  let stored = await database.query(
    `SELECT id, content, status FROM instagram_messages
      WHERE user_id=$1 AND idempotency_key=$2`,
    [userId, replyKey],
  );
  if (!stored.rows[0]) {
    const resolved = await resolveKeys(userId);
    const config = buildAiConfig(igSettings.config, resolved);
    const logger = createLogger(job.id);
    const ai = new AI(config, logger, { record: async () => {} });
    const isFirstMsg = history.filter((m) => m.role === 'assistant').length === 0;
    const reply = stripEscalationMarkers(String((await ai.getReply(history, { isFirstMsg })) || ''));
    if (!reply) return { skipped: 'empty_reply' };
    stored = await database.query(
      `INSERT INTO instagram_messages
         (conversation_id, user_id, participant_id, direction, role, content, status, idempotency_key, raw_payload)
       VALUES ($1,$2,$3,'outbound','assistant',$4,'queued_for_send',$5,$6::jsonb)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING id, content, status`,
      [conversationId, userId, participantId, reply, replyKey, JSON.stringify({ kind: 'ai_reply', sourceMessageIds: pendingIds })],
    );
  }
  const replyRow = stored.rows[0];
  await enqueueOutgoing({
    userId,
    conversationId,
    participantId,
    recipientId: participantId,
    text: replyRow.content,
    replyMessageId: replyRow.id,
  });
  await database.query(
    `UPDATE instagram_messages SET status='answered_by_ai' WHERE id = ANY($1::uuid[]) AND user_id=$2`,
    [pendingIds, userId],
  );
  return { generated: true };
}

// ── Outgoing: quota-gate, send, decrement the SHARED quota ──────────────────
async function processOutgoing(job, deps = {}) {
  const database = deps.database || db;
  const quotaCheck = deps.checkMessageQuota || checkMessageQuota;
  const quotaDecrement = deps.decrementMessageQuota || decrementMessageQuota;
  const accountToken = deps.getAccountToken || getAccountToken;
  const sendMessage = deps.sendDirectMessage || sendDirectMessage;
  const writeLog = deps.logInstagram || logInstagram;
  const { userId, conversationId, recipientId, text, replyMessageId } = job.data;

  // Idempotency guard: skip if a prior attempt already sent this reply.
  const existing = await database.query(
    'SELECT status, provider_message_id FROM instagram_messages WHERE id = $1 AND user_id = $2',
    [replyMessageId, userId],
  );
  if (alreadySent(existing.rows[0])) return { skipped: 'already_sent' };

  const window = await database.query(
    `SELECT window_expires_at > NOW() AS window_open
       FROM instagram_conversations WHERE id=$1 AND user_id=$2 AND participant_id=$3`,
    [conversationId, userId, recipientId],
  );
  if (!window.rows[0] || window.rows[0].window_open !== true) {
    await database.query(
      `UPDATE instagram_messages SET status='expired' WHERE id=$1 AND user_id=$2`,
      [replyMessageId, userId],
    );
    return { skipped: 'window_closed' };
  }

  const quota = await quotaCheck(userId);
  if (shouldBlockSendForQuota(quota)) {
    await database.query(`UPDATE instagram_messages SET status='quota_stop' WHERE id=$1 AND user_id=$2`, [replyMessageId, userId]);
    return { skipped: 'quota_empty' };
  }

  const token = await accountToken(userId);
  if (!token) {
    await database.query(`UPDATE instagram_messages SET status='failed' WHERE id=$1 AND user_id=$2`, [replyMessageId, userId]);
    await writeLog(userId, 'error', 'send', { reason: 'no_token', replyMessageId });
    return { skipped: 'no_token' };
  }

  const claimed = await database.query(
    `UPDATE instagram_messages SET status='sending'
      WHERE id=$1 AND user_id=$2 AND status IN ('queued_for_send','failed') RETURNING id`,
    [replyMessageId, userId],
  );
  if (!claimed.rows[0]) return { skipped: 'already_claimed' };

  let result;
  try {
    result = await sendMessage({ token, recipientId, text });
  } catch (err) {
    await database.query(`UPDATE instagram_messages SET status='failed' WHERE id=$1 AND user_id=$2`, [replyMessageId, userId]);
    await writeLog(userId, 'error', 'send', { message: err.message, replyMessageId });
    throw err; // let BullMQ retry per the attempts policy
  }

  // Persist provider success BEFORE quota bookkeeping. Previously a transient
  // billing DB error threw from this block and BullMQ retried the whole send,
  // delivering the same reply to the customer twice.
  try {
    await database.query(
      `UPDATE instagram_messages SET status='sent', provider_message_id=$2 WHERE id=$1 AND user_id=$3`,
      [replyMessageId, result.messageId, userId],
    );
  } catch (err) {
    await writeLog(userId, 'error', 'send_ambiguous', { message: err.message, replyMessageId, providerMessageId: result.messageId });
    return { sent: true, persisted: false };
  }

  try {
    const decremented = await quotaDecrement(userId);
    if (!decremented || decremented.success === false) {
      await writeLog(userId, 'error', 'quota_decrement', { reason: 'not_decremented', replyMessageId });
    }
  } catch (err) {
    await writeLog(userId, 'error', 'quota_decrement', { message: err.message, replyMessageId });
  }
  return { sent: true };
}

function createWorkers() {
  const connection = createRedisConnection();
  const incoming = new Worker(QUEUE_NAMES.incomingInstagram, processIncoming, {
    connection,
    // One consumer batches all pending inbound rows for a conversation and
    // marks them answered. Serial processing prevents two rapid per-message
    // jobs from generating duplicate replies off the same pending batch.
    concurrency: 1,
  });
  const outgoing = new Worker(QUEUE_NAMES.outgoingInstagram, processOutgoing, {
    connection,
    concurrency: 1,
  });
  for (const [w, name] of [[incoming, 'incoming'], [outgoing, 'outgoing']]) {
    w.on('failed', (jobEntry, err) =>
      console.error(`${new Date().toISOString()} [${WORKER_NAME}:${name}] failed ${jobEntry && jobEntry.id}: ${err && err.message}`));
  }
  return { incoming, outgoing };
}

async function main() {
  if (process.env.INSTAGRAM_ENABLED !== 'true') {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] disabled (INSTAGRAM_ENABLED!=true); exiting.`);
    return;
  }
  createWorkers();
  console.log(`${new Date().toISOString()} [${WORKER_NAME}] started`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  shouldGenerateReply,
  shouldBlockSendForQuota,
  alreadySent,
  buildAiConfig,
  buildReplyKey,
  processIncoming,
  processOutgoing,
  createWorkers,
};
