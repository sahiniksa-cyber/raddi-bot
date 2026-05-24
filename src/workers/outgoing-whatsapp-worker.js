'use strict';

const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, getQueues } = require('../queues/message-queue');
const { normalizeOutgoingJobKey } = require('../queues/outgoing-job-key');
const { decrementMessageQuota } = require('../services/billing/message-quota');
const { TIMERS } = require('../../lib/constants');

const WORKER_NAME = 'outgoing-whatsapp-worker';

async function updateJobStatus(jobKey, fields) {
  if (!db.isConfigured() || !jobKey) return;
  const assignments = [];
  const values = [QUEUE_NAMES.outgoingWhatsapp, jobKey];
  let i = values.length;
  for (const [key, value] of Object.entries(fields)) {
    i++;
    assignments.push(`${key} = $${i}`);
    values.push(value);
  }
  if (!assignments.length) return;
  await db.query(
    `UPDATE jobs
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE queue_name = $1 AND job_key = $2`,
    values,
  );
}

async function markReplyMessage(replyMessageId, status, rawPayload = {}) {
  if (!replyMessageId) return;
  await db.query(
    `UPDATE messages
     SET status = $2,
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
     WHERE id = $1`,
    [replyMessageId, status, JSON.stringify(rawPayload)],
  );
}

async function getPersistedJobCreatedAt(jobKey) {
  if (!db.isConfigured() || !jobKey) return null;
  const result = await db.query(
    `SELECT created_at
     FROM jobs
     WHERE queue_name = $1 AND job_key = $2
     LIMIT 1`,
    [QUEUE_NAMES.outgoingWhatsapp, jobKey],
  );
  return result.rows[0]?.created_at ? new Date(result.rows[0].created_at).getTime() : null;
}

function shouldSkipStaleOutgoingPayload(payload = {}, ageMs, maxAgeMs) {
  if (payload.escalation) return false;
  return maxAgeMs > 0 && ageMs > maxAgeMs;
}

async function skipStaleOutgoingJob(job, { replyMessageId }) {
  const maxAgeMs = parseInt(process.env.OUTGOING_STALE_JOB_MAX_AGE_MS || '600000', 10);
  if (maxAgeMs <= 0) return false;

  const createdAt = await getPersistedJobCreatedAt(job.id) || job.timestamp || Date.now();
  const ageMs = Date.now() - createdAt;
  if (!shouldSkipStaleOutgoingPayload(job.data || {}, ageMs, maxAgeMs)) return false;

  const message = `expired stale outgoing reply age=${Math.round(ageMs / 1000)}s`;
  await markReplyMessage(replyMessageId, 'expired', {
    sentBy: WORKER_NAME,
    expiredAt: new Date().toISOString(),
    error: message,
  });
  await updateJobStatus(job.id, {
    status: 'expired',
    finished_at: new Date(),
    attempts: job.attemptsMade,
    last_error: message,
  });
  return true;
}

async function processOutgoingWhatsapp(job, { getUserBot }) {
  const payload = job.data || {};
  const userId = payload.userId;
  const sender = payload.sender;
  const reply = String(payload.reply || '').trim();
  const replyMessageId = payload.replyMessageId;
  const providerMessageId = payload.providerMessageId;

  if (!userId) throw new Error('Missing userId in outgoing payload');
  if (!sender) throw new Error('Missing sender in outgoing payload');
  if (!reply) throw new Error('Missing reply in outgoing payload');

  if (await skipStaleOutgoingJob(job, { replyMessageId })) {
    return { skipped: true, reason: 'stale_outgoing_reply' };
  }

  const loadedBot = await getUserBot(userId);
  if (shouldCancelOutgoingForStoppedBot(loadedBot, payload)) {
    const message = 'outgoing reply canceled because bot is stopped by owner';
    await markReplyMessage(replyMessageId, 'canceled', {
      sentBy: WORKER_NAME,
      canceledAt: new Date().toISOString(),
      error: message,
    });
    await updateJobStatus(job.id, {
      status: 'canceled',
      finished_at: new Date(),
      attempts: job.attemptsMade,
      last_error: message,
    });
    return { skipped: true, reason: 'bot_stopped_by_owner' };
  }

  await updateJobStatus(job.id, {
    status: 'processing',
    started_at: new Date(),
    attempts: job.attemptsMade,
  });

  const bot = await waitForConnectedBot(loadedBot, {
    reason: `outgoing:${job.id}`,
    timeoutMs: parseInt(process.env.OUTGOING_WAIT_CONNECTED_MS || '45000', 10),
  });

  await sendWhatsappReply(bot, { sender, reply, providerMessageId });

  const dec = await decrementMessageQuota(userId);
  if (!dec.success) {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] sent ${replyMessageId} but quota already empty for ${userId}`);
  }

  await markReplyMessage(replyMessageId, 'sent', {
    sentBy: WORKER_NAME,
    sentAt: new Date().toISOString(),
    quotaRemainingAfter: dec.remaining ?? 0,
  });
  await updateJobStatus(job.id, {
    status: 'completed',
    finished_at: new Date(),
    attempts: job.attemptsMade + 1,
    last_error: null,
  });

  bot.log(`outgoing reply sent to ${sender}`);
  return { sent: true, replyMessageId };
}

function shouldCancelOutgoingForStoppedBot(bot, payload = {}) {
  return bot?.sessionDesiredState === 'stopped' && !payload.escalation;
}

async function sendWhatsappReply(bot, { sender, reply, providerMessageId }) {
  const timeoutMs = TIMERS.SEND_MESSAGE_TIMEOUT_MS;
  return Promise.race([
    sendWhatsappReplyUnchecked(bot, { sender, reply, providerMessageId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), timeoutMs)),
  ]);
}

async function sendWhatsappReplyUnchecked(bot, { sender, reply, providerMessageId }) {
  if (providerMessageId && typeof bot.client.getMessageById === 'function') {
    const original = await bot.client.getMessageById(providerMessageId).catch((err) => {
      bot.log?.(`message reply lookup failed: ${err.message}`);
      return null;
    });
    if (original && typeof original.reply === 'function') {
      return original.reply(reply);
    }
  }

  if (typeof bot.client.getChatById === 'function') {
    const chat = await bot.client.getChatById(sender).catch((err) => {
      bot.log?.(`chat lookup failed for ${sender}: ${err.message}`);
      return null;
    });
    if (chat && typeof chat.sendMessage === 'function') {
      return chat.sendMessage(reply);
    }
  }

  return bot.client.sendMessage(sender, reply);
}

function resolveOutgoingSettleMs(bot) {
  const explicit = process.env.OUTGOING_CONNECTED_SETTLE_MS;
  if (explicit != null && String(explicit).trim() !== '') return parseInt(explicit, 10);
  // Baileys is genuinely connected the moment the socket opens, so a short settle is
  // enough to ride out the post-pairing restart. whatsapp-web.js fires "ready" before the
  // page is fully usable, so it needs a longer settle window.
  return bot?.appState?.whatsappEngine === 'baileys' ? 3000 : 20000;
}

async function waitForConnectedBot(bot, { reason, timeoutMs }) {
  if (!bot) throw new Error('Unable to load user bot');
  if (bot.sessionDesiredState === 'stopped') {
    throw new Error('WhatsApp is stopped by owner');
  }
  const settleMs = resolveOutgoingSettleMs(bot);
  if (bot.appState.status === 'connected' && bot.client && (bot.appState.statusAgeMs || 0) >= settleMs) {
    return bot;
  }

  if (bot.sessionDesiredState === 'running' && ['stopped', 'reconnecting', 'disconnected', 'waiting_qr'].includes(bot.appState.status)) {
    bot.startBot(reason).catch((err) => bot.log?.(`outgoing start failed: ${err.message}`));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bot.appState.status === 'connected' && bot.client) {
      if ((bot.appState.statusAgeMs || 0) >= settleMs) return bot;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw new Error(`WhatsApp is not connected (status=${bot.appState.status})`);
}

async function requeuePersistedOutgoingJobs(limit = 200) {
  if (!db.isConfigured()) return;
  const result = await db.query(
    `SELECT job_key, payload
     FROM jobs
     WHERE queue_name = $1
       AND (
         status IN ('queued', 'processing')
         OR (status = 'failed' AND COALESCE(last_error, '') ILIKE '%not connected%')
       )
     ORDER BY created_at ASC
     LIMIT $2`,
    [QUEUE_NAMES.outgoingWhatsapp, limit],
  );
  if (!result.rows.length) return;

  const { outgoingWhatsapp } = getQueues();
  for (const row of result.rows) {
    const safeJobKey = normalizeOutgoingJobKey(row.job_key, row.payload);
    const existing = safeJobKey ? await outgoingWhatsapp.getJob(safeJobKey).catch(() => null) : null;
    if (existing) {
      if (safeJobKey && safeJobKey !== row.job_key) {
        await updatePersistedJobKey(row.job_key, safeJobKey).catch(() => {});
      }
      const state = await existing.getState().catch(() => null);
      if (state === 'failed') {
        await existing.retry('failed').catch(() => {});
      }
      continue;
    }
    await outgoingWhatsapp.add('send-whatsapp-message', row.payload, {
      jobId: safeJobKey || undefined,
      attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
      backoff: {
        type: 'exponential',
        delay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '15000', 10),
      },
    }).catch((err) => {
      if (!/already exists/i.test(err.message)) throw err;
    });
    if (safeJobKey && safeJobKey !== row.job_key) {
      await updatePersistedJobKey(row.job_key, safeJobKey).catch(() => {});
    }
  }
  console.log(`${new Date().toISOString()} [${WORKER_NAME}] requeued ${result.rows.length} persisted outgoing job(s)`);
}

async function updatePersistedJobKey(oldJobKey, newJobKey) {
  if (!db.isConfigured() || !oldJobKey || !newJobKey || oldJobKey === newJobKey) return;
  await db.query(
    `UPDATE jobs
     SET job_key = $3, updated_at = NOW()
     WHERE queue_name = $1 AND job_key = $2
       AND NOT EXISTS (
         SELECT 1 FROM jobs existing
         WHERE existing.queue_name = $1 AND existing.job_key = $3
       )`,
    [QUEUE_NAMES.outgoingWhatsapp, oldJobKey, newJobKey],
  );
}

function createOutgoingWhatsappWorker({ getUserBot }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');
  const connection = createRedisConnection();
  const worker = new Worker(
    QUEUE_NAMES.outgoingWhatsapp,
    (job) => processOutgoingWhatsapp(job, { getUserBot }),
    {
      connection,
      concurrency: parseInt(process.env.OUTGOING_WORKER_CONCURRENCY || '1', 10),
      lockDuration: parseInt(process.env.OUTGOING_WORKER_LOCK_DURATION_MS || '60000', 10),
    },
  );

  worker.on('completed', (job) => {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] completed ${job.id}`);
  });

  worker.on('error', (err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] error: ${err.message}`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] failed ${job?.id}: ${err.message}`);
    if (job?.id) {
      const attemptsLimit = job.opts?.attempts || parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10);
      const waitingForConnection = /not connected|qr|stopped|reconnecting|disconnected|waiting/i.test(err.message);
      const exhausted = !waitingForConnection && job.attemptsMade >= attemptsLimit;
      await updateJobStatus(job.id, {
        status: exhausted ? 'failed' : 'queued',
        last_error: err.message,
        attempts: job.attemptsMade,
      }).catch(() => {});
      await markReplyMessage(job.data?.replyMessageId, exhausted ? 'send_failed' : 'queued_for_send', {
        sentBy: WORKER_NAME,
        failedAt: new Date().toISOString(),
        error: err.message,
      }).catch(() => {});
    }
  });

  requeuePersistedOutgoingJobs().catch((err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] requeue failed: ${err.message}`);
  });

  return worker;
}

module.exports = {
  createOutgoingWhatsappWorker,
  processOutgoingWhatsapp,
  requeuePersistedOutgoingJobs,
  resolveOutgoingSettleMs,
  sendWhatsappReply,
  shouldCancelOutgoingForStoppedBot,
  shouldSkipStaleOutgoingPayload,
  updatePersistedJobKey,
  waitForConnectedBot,
};
