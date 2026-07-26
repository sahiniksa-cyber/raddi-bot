'use strict';

function clone(value) {
  return structuredClone(value);
}

class CampaignWorkerRepository {
  constructor({
    campaigns = {},
    media = {},
    now = Date.now(),
    policies = {},
    quotas = {},
    recipients = {},
  } = {}) {
    this.state = {
      campaigns: clone(campaigns),
      conversations: {},
      media: clone(media),
      messages: [],
      policies: clone(policies),
      quotas: clone(quotas),
      recipients: clone(recipients),
    };
    this.failOnRecipientMarkerOnce = false;
    this.failOnMediaCursorOnce = false;
    this.failOnTextMarkerOnce = false;
    this.queries = [];
    this.now = Number(now);
    this.transactionWaiters = 0;
    this.transactionActive = false;
    this.transactionTail = Promise.resolve();
  }

  async query(sql, params = []) {
    return this.#query(this.state, sql, params);
  }

  async transaction(callback) {
    this.transactionWaiters += 1;
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise(resolve => {
      release = resolve;
    });
    await previous;
    this.transactionWaiters -= 1;
    this.transactionActive = true;
    try {
      const transactionState = clone(this.state);
      const client = {
        query: (sql, params = []) => this.#query(transactionState, sql, params),
      };
      const result = await callback(client);
      this.state = transactionState;
      return result;
    } finally {
      this.transactionActive = false;
      release();
    }
  }

  async #query(state, sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, params: clone(params) });

    if (normalized.startsWith('SELECT r.*, c.status AS campaign_status')) {
      const [recipientId, campaignId] = params;
      const recipient = state.recipients[recipientId];
      const campaign = state.campaigns[campaignId];
      if (!recipient || !campaign || recipient.campaign_id !== campaignId) return { rows: [] };
      return {
        rows: [{
          ...clone(recipient),
          campaign_status: campaign.status,
          message_text: campaign.message_text,
          interval_min_seconds: campaign.interval_min_seconds,
          interval_max_seconds: campaign.interval_max_seconds,
          audience_rules: clone(campaign.audience_rules),
          campaign_user_id: campaign.user_id,
          campaign_scheduled_at: campaign.scheduled_at || null,
          approved_at: campaign.approved_at,
        }],
      };
    }

    if (normalized.startsWith('UPDATE campaign_recipients r SET status = \'pending\'')) {
      const [staleMs] = params;
      const cutoff = this.now - Number(staleMs);
      const recovered = [];
      for (const recipient of Object.values(state.recipients)) {
        const campaign = state.campaigns[recipient.campaign_id];
        const updatedAt = new Date(recipient.updated_at || 0).getTime();
        if (campaign
            && ['scheduled', 'sending'].includes(campaign.status)
            && recipient.status === 'sending'
            && updatedAt < cutoff) {
          recipient.status = 'pending';
          recipient.last_error = 'recovered_stale_sending';
          recovered.push({ id: recipient.id });
        }
      }
      return { rows: recovered, rowCount: recovered.length };
    }

    if (normalized.startsWith('SELECT r.id, r.campaign_id FROM campaign_recipients r')) {
      const rows = Object.values(state.recipients)
        .filter(recipient => (
          ['scheduled', 'sending'].includes(state.campaigns[recipient.campaign_id]?.status)
          && recipient.status === 'queued'
        ))
        .map(recipient => ({ id: recipient.id, campaign_id: recipient.campaign_id }));
      return { rows };
    }

    if (normalized.includes("last_error = 'recovered_missing_queue_job'")) {
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (!recipient || recipient.status !== 'queued') return { rows: [], rowCount: 0 };
      recipient.status = 'pending';
      recipient.last_error = 'recovered_missing_queue_job';
      return { rows: [{ id: recipientId }], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT id, status, scheduled_at FROM campaigns')) {
      return {
        rows: Object.values(state.campaigns)
          .filter(campaign => ['scheduled', 'sending'].includes(campaign.status))
          .map(campaign => ({
            id: campaign.id,
            status: campaign.status,
            scheduled_at: campaign.scheduled_at || null,
          })),
      };
    }

    if (normalized.startsWith('SELECT c.status AS campaign_status, c.approved_at, r.status AS recipient_status')) {
      const [campaignId, recipientId] = params;
      const campaign = state.campaigns[campaignId];
      const recipient = state.recipients[recipientId];
      return {
        rows: campaign && recipient && recipient.campaign_id === campaignId
          ? [{
              campaign_status: campaign.status,
              approved_at: campaign.approved_at,
              recipient_status: recipient.status,
            }]
          : [],
      };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'sending'")) {
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (!recipient || recipient.status !== 'queued') return { rows: [], rowCount: 0 };
      recipient.status = 'sending';
      recipient.attempts += 1;
      return { rows: [{ id: recipientId }], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaigns SET status = 'sending'")) {
      const [campaignId] = params;
      state.campaigns[campaignId].status = 'sending';
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaigns SET status = 'paused'")) {
      const [campaignId, lastError] = params;
      const campaign = state.campaigns[campaignId];
      campaign.status = 'paused';
      campaign.last_error = lastError;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaigns SET status = $3')) {
      const [campaignId, userId, status] = params;
      const campaign = state.campaigns[campaignId];
      if (!campaign || campaign.user_id !== userId) return { rows: [], rowCount: 0 };
      campaign.status = status;
      return { rows: [clone(campaign)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'pending', last_error = $2")) {
      const [recipientId, lastError] = params;
      const recipient = state.recipients[recipientId];
      recipient.status = 'pending';
      recipient.last_error = lastError;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'pending'") && normalized.includes("status = 'sending'")) {
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (recipient?.status === 'sending') recipient.status = 'pending';
      return { rows: recipient ? [{ id: recipientId }] : [], rowCount: recipient ? 1 : 0 };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'canceled'")) {
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (recipient) recipient.status = 'canceled';
      return { rows: recipient ? [{ id: recipientId }] : [], rowCount: recipient ? 1 : 0 };
    }

    if (normalized.startsWith('SELECT messages_remaining, quota_expires_at, expire_resets_quota FROM billing_accounts')) {
      const [userId] = params;
      const quota = state.quotas[userId];
      return {
        rows: quota ? [{
          messages_remaining: quota.messages_remaining,
          quota_expires_at: null,
          expire_resets_quota: false,
        }] : [],
      };
    }

    if (normalized.startsWith("SELECT config->'merchantPolicy' AS merchant_policy FROM bot_configs")) {
      const [userId] = params;
      return { rows: state.policies[userId] ? [{ merchant_policy: clone(state.policies[userId]) }] : [] };
    }

    if (normalized.startsWith('SELECT * FROM campaign_media WHERE campaign_id = $1')) {
      const [campaignId] = params;
      return { rows: clone(state.media[campaignId] || []) };
    }

    if (normalized.startsWith('SELECT r.quota_decremented, b.messages_remaining FROM campaign_recipients r')) {
      const [recipientId, userId] = params;
      const recipient = state.recipients[recipientId];
      return {
        rows: recipient && recipient.user_id === userId
          ? [{
              quota_decremented: recipient.quota_decremented,
              messages_remaining: state.quotas[userId]?.messages_remaining ?? null,
            }]
          : [],
      };
    }

    if (normalized.startsWith('UPDATE billing_accounts')) {
      const [userId] = params;
      const quota = state.quotas[userId];
      if (!quota || quota.messages_remaining <= 0) return { rows: [], rowCount: 0 };
      quota.messages_remaining -= 1;
      quota.messages_used += 1;
      return {
        rows: [{ messages_remaining: quota.messages_remaining }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('UPDATE campaign_recipients SET quota_decremented = TRUE')) {
      if (this.failOnRecipientMarkerOnce) {
        this.failOnRecipientMarkerOnce = false;
        throw new Error('INJECTED_CRASH_BEFORE_RECIPIENT_MARKER');
      }
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (!recipient) return { rows: [], rowCount: 0 };
      recipient.quota_decremented = true;
      return { rows: [{ id: recipientId }], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaign_recipients SET text_sent = TRUE')) {
      if (this.failOnTextMarkerOnce) {
        this.failOnTextMarkerOnce = false;
        throw new Error('INJECTED_CRASH_BEFORE_TEXT_MARKER');
      }
      const [recipientId, providerMessageIds] = params;
      const recipient = state.recipients[recipientId];
      recipient.text_sent = true;
      recipient.provider_message_ids = JSON.parse(providerMessageIds);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaign_recipients SET media_cursor = $2')) {
      if (this.failOnMediaCursorOnce) {
        this.failOnMediaCursorOnce = false;
        throw new Error('INJECTED_CRASH_BEFORE_MEDIA_CURSOR');
      }
      const [recipientId, mediaCursor, providerMessageIds] = params;
      const recipient = state.recipients[recipientId];
      recipient.media_cursor = mediaCursor;
      recipient.provider_message_ids = JSON.parse(providerMessageIds);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT 1 FROM messages WHERE user_id = $1 AND raw_payload->>'campaignRecipientId' = $2")) {
      const [userId, recipientId] = params;
      const existing = state.messages.find(message => (
        message.user_id === userId
        && String(message.raw_payload.campaignRecipientId) === String(recipientId)
      ));
      return { rows: existing ? [{ '?column?': 1 }] : [] };
    }

    if (normalized.startsWith('INSERT INTO conversations')) {
      const [userId, sender] = params;
      const key = `${userId}:${sender}`;
      state.conversations[key] ||= { id: `conversation-${Object.keys(state.conversations).length + 1}` };
      return { rows: [{ id: state.conversations[key].id }], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO messages')) {
      const [
        conversationId,
        userId,
        sender,
        content,
        providerMessageId,
        rawPayload,
      ] = params;
      state.messages.push({
        conversation_id: conversationId,
        user_id: userId,
        sender,
        content,
        provider_message_id: providerMessageId,
        raw_payload: JSON.parse(rawPayload),
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'sent'")) {
      const [recipientId] = params;
      const recipient = state.recipients[recipientId];
      if (!recipient || recipient.status !== 'sending') return { rows: [], rowCount: 0 };
      recipient.status = 'sent';
      recipient.last_error = null;
      return { rows: [{ id: recipientId }], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaigns SET sent_count = sent_count + 1')) {
      const [campaignId] = params;
      const campaign = state.campaigns[campaignId];
      campaign.sent_count = Number(campaign.sent_count || 0) + 1;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaigns SET failed_count = failed_count + 1')) {
      const [campaignId, lastError] = params;
      const campaign = state.campaigns[campaignId];
      campaign.failed_count = Number(campaign.failed_count || 0) + 1;
      campaign.last_error = lastError;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE')) {
      const [campaignId] = params;
      const campaign = state.campaigns[campaignId];
      return { rows: campaign ? [clone(campaign)] : [] };
    }

    if (normalized.startsWith("SELECT COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('queued','sending')")) {
      const [campaignId] = params;
      const count = Object.values(state.recipients)
        .filter(recipient => recipient.campaign_id === campaignId && ['queued', 'sending'].includes(recipient.status))
        .length;
      return { rows: [{ count }] };
    }

    if (normalized.startsWith("SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'")) {
      const [campaignId] = params;
      const recipient = Object.values(state.recipients)
        .find(row => row.campaign_id === campaignId && row.status === 'pending');
      return { rows: recipient ? [{ id: recipient.id }] : [] };
    }

    if (normalized.startsWith("UPDATE campaign_recipients SET status = 'queued', scheduled_at = NOW()")) {
      const [recipientId, delay] = params;
      const recipient = state.recipients[recipientId];
      recipient.status = 'queued';
      recipient.scheduled_delay = Number(delay);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE campaigns SET status = 'completed'")) {
      const [campaignId] = params;
      const campaign = state.campaigns[campaignId];
      if (campaign && ['approved', 'scheduled', 'sending'].includes(campaign.status)) {
        campaign.status = 'completed';
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE campaign_recipients SET status = $2, last_error = $3')) {
      const [recipientId, status, lastError] = params;
      const recipient = state.recipients[recipientId];
      recipient.status = status;
      recipient.last_error = lastError;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected campaign worker repository query: ${normalized}`);
  }
}

class DurableCampaignTransport {
  constructor() {
    this.reservations = new Map();
    this.sends = [];
  }

  createGateway() {
    return {
      send: request => this.send(request),
    };
  }

  async send(request) {
    const key = `${request.userId}:${request.idempotencyKey}`;
    const existing = this.reservations.get(key);
    if (existing) {
      return {
        decision: 'duplicate',
        reservation: { provider_message_id: existing.providerMessageId },
      };
    }
    const providerMessageId = `provider:${key}`;
    const captured = {
      ...request,
      media: request.media
        ? Object.fromEntries(Object.entries(request.media).map(([name, value]) => (
            [name, Buffer.isBuffer(value) ? Buffer.from(value) : value]
          )))
        : undefined,
    };
    this.sends.push(captured);
    this.reservations.set(key, { providerMessageId });
    return {
      decision: 'sent',
      provider: { providerMessageId },
    };
  }
}

class DeterministicCampaignQueue {
  constructor(initialJobs = []) {
    this.jobs = new Map();
    this.added = [];
    for (const job of initialJobs) this.#store(job);
  }

  #store({ id, state = 'waiting', name = 'deliver-campaign-recipient', data = {}, options = {} }) {
    const queue = this;
    const stored = {
      id,
      name,
      data,
      options,
      state,
      async getState() {
        return this.state;
      },
      async remove() {
        queue.jobs.delete(this.id);
      },
      async changeDelay(delay) {
        this.options.delay = delay;
      },
    };
    this.jobs.set(id, stored);
    return stored;
  }

  async getJob(id) {
    return this.jobs.get(id) || null;
  }

  async add(name, data, options) {
    const job = this.#store({ id: options.jobId, name, data, options, state: options.delay > 0 ? 'delayed' : 'waiting' });
    this.added.push({
      id: job.id,
      name,
      data: clone(data),
      options: clone(options),
    });
    return job;
  }
}

module.exports = {
  CampaignWorkerRepository,
  DeterministicCampaignQueue,
  DurableCampaignTransport,
};
