'use strict';

require('dotenv').config({ quiet: true });

const { Queue, QueueEvents } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('./redis');
const { normalizeOutgoingJobKey } = require('./outgoing-job-key');

const QUEUE_NAMES = Object.freeze({
  incomingMessages: process.env.INCOMING_MESSAGES_QUEUE || 'incoming-messages',
  aiReplies: process.env.AI_REPLIES_QUEUE || 'ai-replies',
  outgoingWhatsapp: process.env.OUTGOING_WHATSAPP_QUEUE || 'outgoing-whatsapp',
});

const DEFAULT_REMOVE_ON_COMPLETE = {
  age: parseInt(process.env.QUEUE_REMOVE_COMPLETE_AGE_SECONDS || '86400', 10),
  count: parseInt(process.env.QUEUE_REMOVE_COMPLETE_COUNT || '1000', 10),
};

const DEFAULT_REMOVE_ON_FAIL = {
  age: parseInt(process.env.QUEUE_REMOVE_FAIL_AGE_SECONDS || '604800', 10),
  count: parseInt(process.env.QUEUE_REMOVE_FAIL_COUNT || '5000', 10),
};

const DEFAULT_AI_REPLY_DEBOUNCE_MS = parseInt(process.env.AI_REPLY_DEBOUNCE_MS || '9000', 10);
const STALE_ACTIVE_JOB_MS = parseInt(process.env.AI_WORKER_LOCK_DURATION_MS || '120000', 10) * 2;

let connection = null;
let queues = null;
let events = null;

function getConnection() {
  if (!connection) connection = createRedisConnection();
  return connection;
}

function createQueue(name) {
  return new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
      backoff: {
        type: 'exponential',
        delay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '15000', 10),
      },
      removeOnComplete: DEFAULT_REMOVE_ON_COMPLETE,
      removeOnFail: DEFAULT_REMOVE_ON_FAIL,
    },
  });
}

function getQueues() {
  if (!queues) {
    queues = {
      incomingMessages: createQueue(QUEUE_NAMES.incomingMessages),
      aiReplies: createQueue(QUEUE_NAMES.aiReplies),
      outgoingWhatsapp: createQueue(QUEUE_NAMES.outgoingWhatsapp),
    };
  }
  return queues;
}

function getQueueEvents() {
  if (!events) {
    events = Object.fromEntries(
      Object.entries(QUEUE_NAMES).map(([key, name]) => [
        key,
        new QueueEvents(name, { connection: getConnection() }),
      ]),
    );
  }
  return events;
}

async function recordJob(queueName, jobKey, payload, metadata = {}) {
  if (!db.isConfigured()) return null;

  // Double-send guard: never reset a job that already reached a terminal "delivered"
  // state. Without the WHERE clause, an enqueueOutgoingWhatsapp retry could reopen a
  // completed/sent_to_provider row and cause the customer to receive the same reply twice.
  const result = await db.query(
    `INSERT INTO jobs (queue_name, job_key, user_id, conversation_id, message_id, status, payload, max_attempts)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6::jsonb, $7)
     ON CONFLICT (queue_name, job_key) WHERE job_key IS NOT NULL DO UPDATE SET
       status = 'queued',
       payload = EXCLUDED.payload,
       attempts = 0,
       last_error = NULL,
       available_at = NOW(),
       finished_at = NULL
     WHERE jobs.status NOT IN ('completed', 'sent_to_provider')
     RETURNING id`,
    [
      queueName,
      jobKey || null,
      metadata.userId || payload.userId || null,
      metadata.conversationId || payload.conversationId || null,
      metadata.messageId || payload.messageId || null,
      JSON.stringify(payload),
      parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
    ],
  );

  return result.rows[0]?.id || null;
}

async function enqueueIncomingMessage(payload, options = {}) {
  const { incomingMessages } = getQueues();
  const jobKey = options.jobKey || payload.providerMessageId || payload.messageId;
  await recordJob(QUEUE_NAMES.incomingMessages, jobKey, payload, payload);
  return incomingMessages.add('process-incoming-message', payload, {
    jobId: jobKey || undefined,
    priority: options.priority,
    delay: options.delay || 0,
  });
}

async function enqueueAiReply(payload, options = {}) {
  const { aiReplies } = getQueues();
  const queueOptions = buildAiReplyQueueOptions(payload, options);
  const jobKey = queueOptions.jobKey;
  await recordJob(QUEUE_NAMES.aiReplies, jobKey, payload, payload);
  await ensureReusableQueueJobId(aiReplies, queueOptions.jobId, queueOptions.delay);
  return aiReplies.add('generate-ai-reply', payload, {
    jobId: queueOptions.jobId || undefined,
    priority: queueOptions.priority,
    delay: queueOptions.delay,
  });
}

function buildAiReplyQueueOptions(payload = {}, options = {}) {
  const debounce = options.debounce !== false;
  const conversationId = payload.conversationId || options.conversationId;
  const fallbackKey = options.jobKey || payload.messageId || conversationId;
  const jobKey = debounce && conversationId ? `conversation-${conversationId}` : fallbackKey;
  return {
    jobKey,
    jobId: jobKey,
    priority: options.priority,
    delay: Number.isFinite(Number(options.delay))
      ? Number(options.delay)
      : debounce
        ? DEFAULT_AI_REPLY_DEBOUNCE_MS
        : 0,
  };
}

async function ensureReusableQueueJobId(queue, jobId, desiredDelayMs) {
  if (!queue || !jobId) return { removed: false, state: null };
  const existing = await queue.getJob(jobId).catch(() => null);
  if (!existing) return { removed: false, state: null };

  const state = await existing.getState().catch(() => null);
  if (state === 'completed' || state === 'failed') {
    await existing.remove();
    return { removed: true, state };
  }

  // Debounce reset: when a delayed job already exists for this key and a new
  // message arrives, BullMQ ignores the `delay` passed to a re-add for the
  // same jobId, so the debounce window would stay anchored to the FIRST
  // message. Restart the timer from the latest message by changing the delay.
  if (state === 'delayed' && Number(desiredDelayMs) > 0 && typeof existing.changeDelay === 'function') {
    try {
      await existing.changeDelay(Number(desiredDelayMs));
      return { removed: false, state, delayChanged: true };
    } catch (err) {
      // The job may have moved states concurrently (e.g. became active).
      // Fall through gracefully without resetting the timer.
      return { removed: false, state, error: err.message };
    }
  }

  if (state === 'active') {
    const processedOn = existing.processedOn || existing.timestamp || 0;
    if (Date.now() - processedOn > STALE_ACTIVE_JOB_MS) {
      // BullMQ's moveToFailed requires a worker lock token that we don't have
      // here. Just remove the stale job — if a real worker still holds the
      // lock (very rare given the staleness threshold of 2x lockDuration),
      // remove() will throw and we'll fall through to leaving the job alone.
      try {
        await existing.remove();
        return { removed: true, state: 'stale_active' };
      } catch (err) {
        return { removed: false, state, error: err.message };
      }
    }
  }

  return { removed: false, state };
}

async function enqueueOutgoingWhatsapp(payload, options = {}) {
  const { outgoingWhatsapp } = getQueues();
  const jobKey = normalizeOutgoingJobKey(options.jobKey || payload.replyMessageId || payload.messageId, payload);
  await recordJob(QUEUE_NAMES.outgoingWhatsapp, jobKey, payload, payload);
  return outgoingWhatsapp.add('send-whatsapp-message', payload, {
    jobId: jobKey || undefined,
    priority: options.priority,
    delay: options.delay || 0,
  });
}

async function closeQueues() {
  const queueRefs = queues ? Object.values(queues) : [];
  const eventRefs = events ? Object.values(events) : [];
  queues = null;
  events = null;

  await Promise.allSettled([...queueRefs.map(q => q.close()), ...eventRefs.map(e => e.close())]);
  if (connection) {
    const current = connection;
    connection = null;
    current.disconnect();
  }
}

module.exports = {
  QUEUE_NAMES,
  buildAiReplyQueueOptions,
  closeQueues,
  enqueueAiReply,
  enqueueIncomingMessage,
  enqueueOutgoingWhatsapp,
  ensureReusableQueueJobId,
  getConnection,
  getQueueEvents,
  getQueues,
  recordJob,
};
