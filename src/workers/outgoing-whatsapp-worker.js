'use strict';

const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, getQueues } = require('../queues/message-queue');
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

  await updateJobStatus(job.id, {
    status: 'processing',
    started_at: new Date(),
    attempts: job.attemptsMade,
  });

  const bot = await waitForConnectedBot(await getUserBot(userId), {
    reason: `outgoing:${job.id}`,
    timeoutMs: parseInt(process.env.OUTGOING_WAIT_CONNECTED_MS || '45000', 10),
  });

  await sendWhatsappReply(bot, { sender, reply, providerMessageId });

  await markReplyMessage(replyMessageId, 'sent', { sentBy: WORKER_NAME, sentAt: new Date().toISOString() });
  await updateJobStatus(job.id, {
    status: 'completed',
    finished_at: new Date(),
    attempts: job.attemptsMade + 1,
    last_error: null,
  });

  bot.log(`outgoing reply sent to ${sender}`);
  return { sent: true, replyMessageId };
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

async function waitForConnectedBot(bot, { reason, timeoutMs }) {
  if (!bot) throw new Error('Unable to load user bot');
  if (bot.appState.status === 'connected' && bot.client) return bot;

  if (bot.sessionDesiredState === 'running' || ['stopped', 'reconnecting', 'disconnected', 'waiting_qr'].includes(bot.appState.status)) {
    bot.startBot(reason).catch((err) => bot.log?.(`outgoing start failed: ${err.message}`));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bot.appState.status === 'connected' && bot.client) {
      const settleMs = parseInt(process.env.OUTGOING_CONNECTED_SETTLE_MS || '20000', 10);
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
    const existing = row.job_key ? await outgoingWhatsapp.getJob(row.job_key).catch(() => null) : null;
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state === 'failed') {
        await existing.retry('failed').catch(() => {});
      }
      continue;
    }
    await outgoingWhatsapp.add('send-whatsapp-message', row.payload, {
      jobId: row.job_key || undefined,
      attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
      backoff: {
        type: 'exponential',
        delay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '15000', 10),
      },
    }).catch((err) => {
      if (!/already exists/i.test(err.message)) throw err;
    });
  }
  console.log(`${new Date().toISOString()} [${WORKER_NAME}] requeued ${result.rows.length} persisted outgoing job(s)`);
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
  sendWhatsappReply,
  waitForConnectedBot,
};
