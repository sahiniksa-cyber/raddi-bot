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

const WORKER_NAME = 'instagram-worker';

// ── Pure, unit-tested decision helpers ──────────────────────────────────────
function shouldGenerateReply(igSettings) {
  return Boolean(igSettings && igSettings.enabled === true);
}

function shouldBlockSendForQuota(quota) {
  return Boolean(quota && quota.canReply === false);
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
async function processIncoming(job) {
  const { userId, conversationId, participantId } = job.data;
  const igSettings = await resolveInstagramConfig(userId);
  if (!shouldGenerateReply(igSettings)) return { skipped: 'ai_disabled' };

  const history = await buildInstagramHistory(conversationId, userId, igSettings.config);
  if (!history.length) return { skipped: 'empty_history' };

  const resolved = await resolveConfigForAI(userId);
  const config = buildAiConfig(igSettings.config, resolved);
  const logger = createLogger(job.id);
  const ai = new AIClient(config, logger, { record: async () => {} });

  const isFirstMsg = history.filter((m) => m.role === 'assistant').length === 0;
  const reply = String((await ai.getReply(history, { isFirstMsg })) || '').trim();
  if (!reply) return { skipped: 'empty_reply' };

  const stored = await db.query(
    `INSERT INTO instagram_messages
       (conversation_id, user_id, participant_id, direction, role, content, status)
     VALUES ($1,$2,$3,'outbound','assistant',$4,'queued_for_send') RETURNING id`,
    [conversationId, userId, participantId, reply],
  );
  await enqueueOutgoingInstagram({
    userId,
    conversationId,
    participantId,
    recipientId: participantId,
    text: reply,
    replyMessageId: stored.rows[0].id,
  });
  return { generated: true };
}

// ── Outgoing: quota-gate, send, decrement the SHARED quota ──────────────────
async function processOutgoing(job) {
  const { userId, recipientId, text, replyMessageId } = job.data;

  const quota = await checkMessageQuota(userId);
  if (shouldBlockSendForQuota(quota)) {
    await db.query(`UPDATE instagram_messages SET status='quota_stop' WHERE id=$1`, [replyMessageId]);
    return { skipped: 'quota_empty' };
  }

  const token = await getAccountToken(userId);
  if (!token) {
    await db.query(`UPDATE instagram_messages SET status='failed' WHERE id=$1`, [replyMessageId]);
    await logInstagram(userId, 'error', 'send', { reason: 'no_token', replyMessageId });
    return { skipped: 'no_token' };
  }

  try {
    const result = await sendDirectMessage({ token, recipientId, text });
    // SHARED quota — identical to WhatsApp: one reply == one message.
    await decrementMessageQuota(userId);
    await db.query(
      `UPDATE instagram_messages SET status='sent', provider_message_id=$2 WHERE id=$1`,
      [replyMessageId, result.messageId],
    );
    return { sent: true };
  } catch (err) {
    await db.query(`UPDATE instagram_messages SET status='failed' WHERE id=$1`, [replyMessageId]);
    await logInstagram(userId, 'error', 'send', { message: err.message, replyMessageId });
    throw err; // let BullMQ retry per the attempts policy
  }
}

function createWorkers() {
  const connection = createRedisConnection();
  const incoming = new Worker(QUEUE_NAMES.incomingInstagram, processIncoming, {
    connection,
    concurrency: parseInt(process.env.INSTAGRAM_WORKER_CONCURRENCY || '2', 10),
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
  buildAiConfig,
  processIncoming,
  processOutgoing,
  createWorkers,
};
