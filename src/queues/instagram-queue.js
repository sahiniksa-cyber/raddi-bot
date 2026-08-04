'use strict';

require('dotenv').config({ quiet: true });

/**
 * Dedicated BullMQ queues for the Instagram module — completely separate from
 * the WhatsApp queues in message-queue.js. A stuck/failed Instagram queue can
 * never block the WhatsApp pipeline. Names are env-overridable.
 */

const { Queue } = require('bullmq');
const { createRedisConnection } = require('./redis');

const QUEUE_NAMES = Object.freeze({
  incomingInstagram: process.env.INCOMING_INSTAGRAM_QUEUE || 'incoming-instagram',
  outgoingInstagram: process.env.OUTGOING_INSTAGRAM_QUEUE || 'outgoing-instagram',
});

let connection = null;
let queues = null;

function getConnection() {
  if (!connection) connection = createRedisConnection();
  return connection;
}

// Default BullMQ job options — extracted as a pure function so the retry ceiling
// (a permanent failure must NOT loop forever) is unit-testable without Redis.
function buildJobOptions(env = process.env) {
  return {
    attempts: parseInt(env.QUEUE_JOB_ATTEMPTS || '3', 10),
    backoff: { type: 'exponential', delay: parseInt(env.QUEUE_BACKOFF_DELAY_MS || '15000', 10) },
    removeOnComplete: {
      age: parseInt(env.QUEUE_REMOVE_COMPLETE_AGE_SECONDS || '86400', 10),
      count: parseInt(env.QUEUE_REMOVE_COMPLETE_COUNT || '1000', 10),
    },
    removeOnFail: {
      age: parseInt(env.QUEUE_REMOVE_FAIL_AGE_SECONDS || '604800', 10),
      count: parseInt(env.QUEUE_REMOVE_FAIL_COUNT || '5000', 10),
    },
  };
}

function createQueue(name) {
  return new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: buildJobOptions(),
  });
}

function getQueues() {
  if (!queues) {
    queues = {
      incomingInstagram: createQueue(QUEUE_NAMES.incomingInstagram),
      outgoingInstagram: createQueue(QUEUE_NAMES.outgoingInstagram),
    };
  }
  return queues;
}

// Test seam: inject fake queues so unit tests never touch Redis.
function __setQueuesForTest(fake) { queues = fake; }

async function removeTerminalJob(queue, jobId) {
  if (!jobId || typeof queue.getJob !== 'function') return;
  const existing = await queue.getJob(jobId);
  if (!existing || typeof existing.getState !== 'function') return;
  const state = await existing.getState();
  if ((state === 'completed' || state === 'failed') && typeof existing.remove === 'function') {
    await existing.remove();
  }
}

async function enqueueIncomingInstagram(payload, options = {}) {
  const { incomingInstagram } = getQueues();
  const jobId = options.jobKey || payload.providerMessageId || payload.messageId || undefined;
  // Meta retries the same delivery after transient failures. BullMQ retains
  // terminal jobs, so remove only terminal copies before re-adding. Waiting or
  // active copies remain the deduplication barrier.
  await removeTerminalJob(incomingInstagram, jobId);
  return incomingInstagram.add('process-incoming-instagram', payload, { jobId, delay: options.delay || 0 });
}

async function enqueueOutgoingInstagram(payload, options = {}) {
  const { outgoingInstagram } = getQueues();
  const jobId = options.jobKey || payload.replyMessageId || payload.messageId || undefined;
  return outgoingInstagram.add('send-instagram-message', payload, { jobId, delay: options.delay || 0 });
}

module.exports = {
  QUEUE_NAMES,
  getQueues,
  buildJobOptions,
  enqueueIncomingInstagram,
  enqueueOutgoingInstagram,
  __setQueuesForTest,
  removeTerminalJob,
};
