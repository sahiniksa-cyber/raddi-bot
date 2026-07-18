'use strict';

const fs = require('fs/promises');
const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { CAMPAIGN_QUEUE_NAME, enqueueCampaignRecipient } = require('../queues/campaign-queue');
const { checkMessageQuota, decrementMessageQuota } = require('../services/billing/message-quota');
const { buildProductCatalog } = require('../services/products/product-knowledge');
const { normalizeAudienceRules } = require('../services/campaigns/campaign-service');
const { normalizeUploadFilename } = require('../services/campaigns/media-store');
const {
  INTEREST_RE,
  ORDER_CLAIM_RE,
  ORDER_REFERENCE_RE,
  classifyConversationDeterministic,
  mergeSignals,
  upsertSignals,
  validateAiSignals,
} = require('../services/campaigns/smart-segmentation');

const CAMPAIGN_RECOVERY_STALE_MS = Math.max(120000, parseInt(process.env.CAMPAIGN_RECOVERY_STALE_MS || '300000', 10));

function providerId(result) {
  return String(result?.key?.id || result?.id?._serialized || result?.id || '').trim();
}

function randomDelayMs(campaign) {
  const min = Math.max(30, Number(campaign.interval_min_seconds) || 30);
  const max = Math.max(min, Number(campaign.interval_max_seconds) || min);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

async function scheduleNextRecipient(campaignId, { database = db, delay = 0, campaignQueue } = {}) {
  const selected = await database.transaction(async client => {
    const campaignResult = await client.query(`SELECT * FROM campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign || !['approved', 'scheduled', 'sending'].includes(campaign.status)) return null;
    const inFlight = await client.query(
      `SELECT COUNT(*)::int AS count FROM campaign_recipients
       WHERE campaign_id = $1 AND status IN ('queued','sending')`,
      [campaignId],
    );
    if (Number(inFlight.rows[0]?.count || 0) > 0) return null;
    const recipientResult = await client.query(
      `SELECT id FROM campaign_recipients
       WHERE campaign_id = $1 AND status = 'pending'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      [campaignId],
    );
    const recipient = recipientResult.rows[0];
    if (!recipient) {
      await client.query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('approved','scheduled','sending')`,
        [campaignId],
      );
      return null;
    }
    await client.query(
      `UPDATE campaign_recipients SET status = 'queued', scheduled_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE id = $1`,
      [recipient.id, Math.max(0, Number(delay) || 0)],
    );
    return recipient.id;
  });
  if (!selected) return null;
  try {
    await enqueueCampaignRecipient({ campaignId, recipientId: selected, delay, campaignQueue });
    return selected;
  } catch (error) {
    await database.query(
      `UPDATE campaign_recipients SET status = 'pending', last_error = $2, updated_at = NOW() WHERE id = $1 AND status = 'queued'`,
      [selected, error.message],
    ).catch(() => {});
    throw error;
  }
}

async function recoverCampaignDeliveries({ database = db, campaignQueue, staleMs = CAMPAIGN_RECOVERY_STALE_MS } = {}) {
  const queue = campaignQueue || require('../queues/campaign-queue').getCampaignQueue();
  const staleAfterMs = Math.max(120000, Number(staleMs) || CAMPAIGN_RECOVERY_STALE_MS);
  const summary = { staleSending: 0, missingJobs: 0, scheduled: 0 };

  const stale = await database.query(
    `UPDATE campaign_recipients r SET status = 'pending',
       last_error = 'recovered_stale_sending', updated_at = NOW()
     FROM campaigns c
     WHERE c.id = r.campaign_id
       AND c.status IN ('scheduled','sending')
       AND r.status = 'sending'
       AND r.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
     RETURNING r.id`,
    [staleAfterMs],
  );
  summary.staleSending = stale.rows.length;

  const queued = await database.query(
    `SELECT r.id, r.campaign_id FROM campaign_recipients r
     JOIN campaigns c ON c.id = r.campaign_id
     WHERE c.status IN ('scheduled','sending') AND r.status = 'queued'
     ORDER BY r.updated_at ASC LIMIT 1000`,
  );
  for (const recipient of queued.rows) {
    const job = await queue.getJob(`campaign-${recipient.id}`).catch(() => null);
    const state = job ? await job.getState().catch(() => null) : null;
    if (job && ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'].includes(state)) continue;
    if (job) await job.remove().catch(() => {});
    const reset = await database.query(
      `UPDATE campaign_recipients SET status = 'pending', last_error = 'recovered_missing_queue_job', updated_at = NOW()
       WHERE id = $1 AND status = 'queued' RETURNING id`,
      [recipient.id],
    );
    summary.missingJobs += reset.rows.length;
  }

  const activeCampaigns = await database.query(
    `SELECT id, status, scheduled_at FROM campaigns
     WHERE status IN ('scheduled','sending') ORDER BY updated_at ASC LIMIT 1000`,
  );
  for (const campaign of activeCampaigns.rows) {
    const delay = campaign.status === 'scheduled' && campaign.scheduled_at
      ? Math.max(0, new Date(campaign.scheduled_at).getTime() - Date.now())
      : 0;
    const selected = await scheduleNextRecipient(campaign.id, { database, delay, campaignQueue: queue });
    if (selected) summary.scheduled += 1;
  }
  return summary;
}

async function sendMedia(bot, sender, media) {
  const buffer = await fs.readFile(media.storage_path);
  const originalName = normalizeUploadFilename(
    media.original_name,
    media.kind === 'document' ? 'document.pdf' : 'media',
  );
  const target = bot.whatsappEngine === 'whatsapp-web'
    ? String(sender).replace(/@s\.whatsapp\.net$/i, '@c.us')
    : sender;
  if (bot.whatsappEngine === 'baileys') {
    const content = media.kind === 'image'
      ? { image: buffer, mimetype: media.mime_type }
      : media.kind === 'video'
        ? { video: buffer, mimetype: media.mime_type }
        : {
            document: buffer,
            mimetype: media.mime_type,
            fileName: originalName,
          };
    return bot.client.sendMessage(target, content);
  }
  const { MessageMedia } = require('whatsapp-web.js');
  const encoded = buffer.toString('base64');
  const payload = new MessageMedia(media.mime_type, encoded, originalName);
  return bot.client.sendMessage(target, payload);
}

async function sendCampaignText(bot, sender, message) {
  const target = bot.whatsappEngine === 'whatsapp-web'
    ? String(sender).replace(/@s\.whatsapp\.net$/i, '@c.us')
    : sender;
  return bot.client.sendMessage(target, message);
}

async function recordOutbound(database, campaign, recipient, providerMessageIds) {
  const existing = await database.query(
    `SELECT 1 FROM messages WHERE user_id = $1 AND raw_payload->>'campaignRecipientId' = $2 LIMIT 1`,
    [campaign.user_id, String(recipient.id)],
  );
  if (existing.rows[0]) return;
  const conversationResult = await database.query(
    `INSERT INTO conversations (user_id, sender, phone_number, metadata, last_message_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [campaign.user_id, recipient.sender, recipient.normalized_phone || null,
      JSON.stringify(recipient.customer_name ? { name: recipient.customer_name } : {})],
  );
  await database.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1,$2,$3,'outbound','assistant',$4,$5,'sent',$6::jsonb)`,
    [conversationResult.rows[0].id, campaign.user_id, recipient.sender,
      campaign.message_text || `[Campaign media: ${providerMessageIds.length}]`,
      providerMessageIds[providerMessageIds.length - 1] || null,
      JSON.stringify({ campaignId: campaign.id, campaignRecipientId: recipient.id, providerMessageIds })],
  );
}

async function processCampaignSegmentation(job, { database = db, getUserBot } = {}) {
  const { userId, conversationId, sender } = job.data || {};
  if (!userId || !conversationId || !sender) return { skipped: true, reason: 'missing_payload' };
  const bot = await getUserBot(userId);
  const config = typeof bot?.resolveConfig === 'function' ? await bot.resolveConfig() : (bot?.config || {});
  bot?.ai?.updateConfig?.(config);
  const products = buildProductCatalog(config);
  if (!products.length) return { skipped: true, reason: 'no_products' };
  const messageResult = await database.query(
    `SELECT id, direction, role, content, created_at FROM messages
     WHERE user_id = $1 AND conversation_id = $2 AND direction = 'inbound'
     ORDER BY created_at ASC LIMIT 200`,
    [userId, conversationId],
  );
  const messages = messageResult.rows;
  const deterministic = classifyConversationDeterministic({ messages, config });
  let aiSignals = [];
  const recentText = messages.slice(-10).map(message => message.content).join('\n');
  const commercialCue = INTEREST_RE.test(recentText) || ORDER_CLAIM_RE.test(recentText) || ORDER_REFERENCE_RE.test(recentText);
  const aiEnabled = process.env.CAMPAIGN_LIVE_AI_ENABLED !== 'false';
  if (aiEnabled && commercialCue && deterministic.length === 0 && typeof bot?.ai?.classifyCampaignCustomer === 'function') {
    const raw = await bot.ai.classifyCampaignCustomer({ messages, products });
    aiSignals = validateAiSignals({ signals: raw, config, messages });
  }
  const signals = mergeSignals(deterministic, aiSignals);
  if (!signals.length) return { updated: 0 };
  const saved = await upsertSignals({ database, userId, conversationId, sender, signals });
  return { updated: saved.length, usedAi: aiSignals.length > 0 };
}

async function recipientMatchesKeywordAudience(database, campaign, recipient, audienceRules) {
  const rules = normalizeAudienceRules(audienceRules);
  if (rules.source !== 'keywords') return false;
  // Raw imported messages are deleted after explicit campaign approval. The
  // materialized delivery address is then the approved audience source.
  if (recipient.source === 'saved_history_number') return Boolean(recipient.sender);
  if (recipient.source === 'keyword_history') {
    const params = [campaign.user_id, recipient.sender, rules.searchTerms];
    const clauses = [
      `user_id = $1`,
      `sender = $2`,
      `direction = 'inbound'`,
      `EXISTS (
         SELECT 1 FROM unnest($3::text[]) AS keyword(term)
         WHERE STRPOS(LOWER(content), LOWER(keyword.term)) > 0
       )`,
    ];
    if (rules.dateFrom) {
      params.push(rules.dateFrom);
      clauses.push(`message_at >= $${params.length}::timestamptz`);
    }
    if (rules.dateTo) {
      params.push(rules.dateTo);
      clauses.push(`message_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const result = await database.query(
      `SELECT 1 FROM whatsapp_history_messages WHERE ${clauses.join(' AND ')} LIMIT 1`,
      params,
    );
    return Boolean(result.rows[0]);
  }
  if (!recipient.conversation_id) return false;
  const params = [campaign.user_id, recipient.conversation_id, rules.searchTerms];
  const clauses = [
    `user_id = $1`,
    `conversation_id = $2`,
    `direction = 'inbound'`,
    `EXISTS (
       SELECT 1 FROM unnest($3::text[]) AS keyword(term)
       WHERE STRPOS(LOWER(content), LOWER(keyword.term)) > 0
     )`,
  ];
  if (rules.dateFrom) {
    params.push(rules.dateFrom);
    clauses.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (rules.dateTo) {
    params.push(rules.dateTo);
    clauses.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  const result = await database.query(
    `SELECT 1 FROM messages WHERE ${clauses.join(' AND ')} LIMIT 1`,
    params,
  );
  return Boolean(result.rows[0]);
}

async function processCampaignRecipient(job, { database = db, getUserBot } = {}) {
  const { campaignId, recipientId } = job.data || {};
  const loaded = await database.transaction(async client => {
    const result = await client.query(
      `SELECT r.*, c.status AS campaign_status, c.message_text, c.interval_min_seconds,
              c.interval_max_seconds, c.audience_rules, c.user_id AS campaign_user_id, c.scheduled_at AS campaign_scheduled_at,
              c.approved_at
       FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.id = $1 AND r.campaign_id = $2 FOR UPDATE OF r, c`,
      [recipientId, campaignId],
    );
    const row = result.rows[0];
    if (!row || ['sent', 'skipped', 'failed', 'canceled'].includes(row.status)) return null;
    if (!['approved', 'scheduled', 'sending'].includes(row.campaign_status) || !row.approved_at) {
      await client.query(`UPDATE campaign_recipients SET status = 'pending', updated_at = NOW() WHERE id = $1`, [recipientId]);
      return null;
    }
    await client.query(`UPDATE campaign_recipients SET status = 'sending', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [recipientId]);
    await client.query(
      `UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [campaignId],
    );
    return {
      campaign: {
        id: campaignId,
        user_id: row.campaign_user_id,
        message_text: row.message_text,
        audience_rules: row.audience_rules,
        interval_min_seconds: row.interval_min_seconds,
        interval_max_seconds: row.interval_max_seconds,
      },
      recipient: row,
    };
  });
  if (!loaded) return { skipped: true };

  const { campaign, recipient } = loaded;
  try {
    const audienceRules = campaign.audience_rules && typeof campaign.audience_rules === 'object'
      ? campaign.audience_rules
      : JSON.parse(campaign.audience_rules || '{}');
    if (audienceRules.source === 'smart' && recipient.product_key) {
      // Refresh from the latest messages immediately before delivery. This
      // closes the race where the customer orders seconds before a scheduled
      // campaign send while the debounced background segmentation job is still
      // waiting in the queue.
      await processCampaignSegmentation({
        data: {
          userId: campaign.user_id,
          conversationId: recipient.conversation_id,
          sender: recipient.sender,
        },
      }, { database, getUserBot });
      const currentSignal = await database.query(
        `SELECT state FROM customer_product_signals
         WHERE user_id = $1 AND sender = $2 AND product_key = $3 LIMIT 1`,
        [campaign.user_id, recipient.sender, recipient.product_key],
      );
      const allowedStates = Array.isArray(audienceRules.states) ? audienceRules.states : [];
      if (!currentSignal.rows[0] || (allowedStates.length && !allowedStates.includes(currentSignal.rows[0].state))) {
        await database.transaction(async client => {
          await client.query(
            `UPDATE campaign_recipients SET status = 'skipped', last_error = 'smart_segment_changed', updated_at = NOW() WHERE id = $1`,
            [recipientId],
          );
          await client.query(`UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = NOW() WHERE id = $1`, [campaignId]);
        });
        await scheduleNextRecipient(campaignId, { database, delay: 0 });
        return { skipped: true, reason: 'smart_segment_changed' };
      }
    }
    if (audienceRules.source === 'keywords') {
      const stillMatches = await recipientMatchesKeywordAudience(database, campaign, recipient, audienceRules);
      if (!stillMatches) {
        await database.transaction(async client => {
          await client.query(
            `UPDATE campaign_recipients SET status = 'skipped', last_error = 'keyword_match_changed', updated_at = NOW() WHERE id = $1`,
            [recipientId],
          );
          await client.query(`UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = NOW() WHERE id = $1`, [campaignId]);
        });
        await scheduleNextRecipient(campaignId, { database, delay: 0 });
        return { skipped: true, reason: 'keyword_match_changed' };
      }
    }

    const quota = await checkMessageQuota(campaign.user_id, { database });
    if (!quota.canReply) {
      await database.query(`UPDATE campaigns SET status = 'paused', last_error = $2, updated_at = NOW() WHERE id = $1`, [campaignId, `quota:${quota.reason}`]);
      await database.query(`UPDATE campaign_recipients SET status = 'pending', last_error = $2, updated_at = NOW() WHERE id = $1`, [recipientId, `quota:${quota.reason}`]);
      return { paused: true, reason: quota.reason };
    }

    const bot = await getUserBot(campaign.user_id);
    if (!bot?.client || !bot.connection?.ready || bot.connection?.status !== 'connected') {
      const error = new Error('WhatsApp is not connected');
      error.code = 'WHATSAPP_NOT_CONNECTED';
      throw error;
    }

    const mediaResult = await database.query(
      `SELECT * FROM campaign_media WHERE campaign_id = $1 ORDER BY sort_order`,
      [campaignId],
    );
    const ids = Array.isArray(recipient.provider_message_ids) ? [...recipient.provider_message_ids] : [];
    let cursor = Number(recipient.media_cursor) || 0;
    for (; cursor < mediaResult.rows.length; cursor += 1) {
      const result = await sendMedia(bot, recipient.sender, mediaResult.rows[cursor]);
      const id = providerId(result);
      if (id) ids.push(id);
      await database.query(
        `UPDATE campaign_recipients SET media_cursor = $2, provider_message_ids = $3::jsonb, updated_at = NOW() WHERE id = $1`,
        [recipientId, cursor + 1, JSON.stringify(ids)],
      );
    }
    if (!recipient.text_sent) {
      if (String(campaign.message_text || '').trim()) {
        const result = await sendCampaignText(bot, recipient.sender, campaign.message_text);
        const id = providerId(result);
        if (id) ids.push(id);
      }
      await database.query(
        `UPDATE campaign_recipients SET text_sent = TRUE, provider_message_ids = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [recipientId, JSON.stringify(ids)],
      );
    }

    if (!recipient.quota_decremented) {
      const decremented = await decrementMessageQuota(campaign.user_id, { database });
      if (!decremented.success) throw new Error('Quota changed before campaign completion');
      await database.query(
        `UPDATE campaign_recipients SET quota_decremented = TRUE, updated_at = NOW() WHERE id = $1`,
        [recipientId],
      );
    }
    await recordOutbound(database, campaign, recipient, ids);
    await database.transaction(async client => {
      await client.query(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
        [recipientId],
      );
      await client.query(`UPDATE campaigns SET sent_count = sent_count + 1, updated_at = NOW() WHERE id = $1`, [campaignId]);
    });
    await scheduleNextRecipient(campaignId, { database, delay: randomDelayMs(campaign) });
    return { sent: true };
  } catch (error) {
    const attempts = Number(job.opts?.attempts || 1);
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    await database.query(
      `UPDATE campaign_recipients SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
      [recipientId, finalAttempt ? 'failed' : 'queued', String(error.message || error).slice(0, 1000)],
    );
    if (!finalAttempt) throw error;
    await database.query(`UPDATE campaigns SET failed_count = failed_count + 1, last_error = $2, updated_at = NOW() WHERE id = $1`, [campaignId, String(error.message || error).slice(0, 1000)]);
    await scheduleNextRecipient(campaignId, { database, delay: randomDelayMs(campaign) });
    return { failed: true, error: error.message };
  }
}

function createCampaignWorker({ getUserBot, database = db } = {}) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot is required');
  const worker = new Worker(
    CAMPAIGN_QUEUE_NAME,
    job => job.name === 'refresh-campaign-segmentation'
      ? processCampaignSegmentation(job, { database, getUserBot })
      : processCampaignRecipient(job, { database, getUserBot }),
    { connection: createRedisConnection(), concurrency: 1, lockDuration: 120000 },
  );
  worker.on('completed', job => {
    console.log(`${new Date().toISOString()} [campaign-worker] completed ${job?.id || 'unknown'}`);
  });
  worker.on('failed', (job, error) => {
    console.error(`${new Date().toISOString()} [campaign-worker] failed ${job?.id || 'unknown'}: ${error.message}`);
  });
  worker.on('error', error => {
    console.error(`${new Date().toISOString()} [campaign-worker] error: ${error.message}`);
  });
  return worker;
}

module.exports = {
  createCampaignWorker,
  processCampaignSegmentation,
  processCampaignRecipient,
  recoverCampaignDeliveries,
  recipientMatchesKeywordAudience,
  randomDelayMs,
  sendMedia,
  sendCampaignText,
  scheduleNextRecipient,
};
