'use strict';

require('dotenv').config({ quiet: true });

const { Queue, QueueEvents } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('./redis');

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
  const jobKey = options.jobKey || payload.messageId || payload.conversationId;
  await recordJob(QUEUE_NAMES.aiReplies, jobKey, payload, payload);
  return aiReplies.add('generate-ai-reply', payload, {
    jobId: jobKey || undefined,
    priority: options.priority,
    delay: options.delay || 0,
  });
}

async function enqueueOutgoingWhatsapp(payload, options = {}) {
  const { outgoingWhatsapp } = getQueues();
  const jobKey = options.jobKey || payload.replyMessageId || payload.messageId;
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
  closeQueues,
  enqueueAiReply,
  enqueueIncomingMessage,
  enqueueOutgoingWhatsapp,
  getConnection,
  getQueueEvents,
  getQueues,
  recordJob,
};
