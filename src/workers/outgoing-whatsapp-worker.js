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

  if (!userId) throw new Error('Missing userId in outgoing payload');
  if (!sender) throw new Error('Missing sender in outgoing payload');
  if (!reply) throw new Error('Missing reply in outgoing payload');

  await updateJobStatus(job.id, {
    status: 'processing',
    started_at: new Date(),
    attempts: job.attemptsMade,
  });

  const bot = await getUserBot(userId);
  if (!bot?.client || bot.appState.status !== 'connected') {
    throw new Error(`WhatsApp is not connected (status=${bot?.appState?.status || 'unknown'})`);
  }

  await Promise.race([
    bot.client.sendMessage(sender, reply),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
  ]);

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

async function requeuePersistedOutgoingJobs(limit = 200) {
  if (!db.isConfigured()) return;
  const result = await db.query(
    `SELECT job_key, payload
     FROM jobs
     WHERE queue_name = $1
       AND status IN ('queued', 'processing')
     ORDER BY created_at ASC
     LIMIT $2`,
    [QUEUE_NAMES.outgoingWhatsapp, limit],
  );
  if (!result.rows.length) return;

  const { outgoingWhatsapp } = getQueues();
  for (const row of result.rows) {
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
      await updateJobStatus(job.id, {
        status: 'failed',
        last_error: err.message,
        attempts: job.attemptsMade,
      }).catch(() => {});
      await markReplyMessage(job.data?.replyMessageId, 'send_failed', {
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
};
