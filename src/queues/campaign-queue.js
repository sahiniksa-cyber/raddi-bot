'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./message-queue');

const CAMPAIGN_QUEUE_NAME = process.env.CAMPAIGN_QUEUE || 'campaign-deliveries';
let queue = null;

function getCampaignQueue() {
  if (!queue) {
    queue = new Queue(CAMPAIGN_QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: Math.max(1, parseInt(process.env.CAMPAIGN_JOB_ATTEMPTS || '3', 10)),
        backoff: { type: 'exponential', delay: parseInt(process.env.CAMPAIGN_RETRY_DELAY_MS || '30000', 10) },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      },
    });
  }
  return queue;
}

async function enqueueCampaignRecipient({ campaignId, recipientId, delay = 0, campaignQueue = getCampaignQueue() } = {}) {
  const jobId = `campaign-${recipientId}`;
  const existing = await campaignQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => null);
    if (state === 'delayed' && typeof existing.changeDelay === 'function') {
      await existing.changeDelay(Math.max(0, Number(delay) || 0));
    }
    if (!['completed', 'failed'].includes(state)) return existing;
    await existing.remove().catch(() => {});
  }
  return campaignQueue.add(
    'deliver-campaign-recipient',
    { campaignId, recipientId },
    { jobId, delay: Math.max(0, Number(delay) || 0) },
  );
}

async function enqueueCampaignSegmentation({ userId, conversationId, sender, messageId } = {}) {
  if (!userId || !conversationId || !sender) return null;
  const campaignQueue = getCampaignQueue();
  const jobId = `campaign-signal-${conversationId}`;
  const delay = Math.max(1000, parseInt(process.env.CAMPAIGN_SEGMENTATION_DEBOUNCE_MS || '5000', 10));
  const existing = await campaignQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => null);
    if (state === 'delayed' && typeof existing.changeDelay === 'function') {
      await existing.updateData({ userId, conversationId, sender, messageId });
      await existing.changeDelay(delay);
    }
    if (state === 'active') {
      return campaignQueue.add(
        'refresh-campaign-segmentation',
        { userId, conversationId, sender, messageId },
        { delay, priority: 1 },
      );
    }
    if (!['completed', 'failed'].includes(state)) return existing;
    await existing.remove().catch(() => {});
  }
  return campaignQueue.add(
    'refresh-campaign-segmentation',
    { userId, conversationId, sender, messageId },
    { jobId, delay, priority: 1 },
  );
}

async function closeCampaignQueue() {
  if (!queue) return;
  const current = queue;
  queue = null;
  await current.close();
}

module.exports = {
  CAMPAIGN_QUEUE_NAME,
  closeCampaignQueue,
  enqueueCampaignRecipient,
  enqueueCampaignSegmentation,
  getCampaignQueue,
};
