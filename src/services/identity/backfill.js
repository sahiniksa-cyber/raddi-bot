'use strict';

/**
 * One-time backfill that links existing WhatsApp data to canonical customers:
 * every conversation and campaign_contact without a customer_id is run through
 * identity resolution and stamped with the resolved customer_id. Idempotent —
 * re-running only touches still-unlinked rows. Metrics are recomputed per
 * customer afterwards so segments reflect the linked history.
 */

const db = require('../../db/client');
const defaultResolver = require('./identity-resolver');
const defaultMetrics = require('./customer-metrics');

async function backfillConversations(userId, deps = {}) {
  const database = deps.database || db;
  const resolver = deps.resolver || defaultResolver;
  const batchSize = deps.batchSize || 500;
  const touched = new Set();
  let processed = 0;
  // Loop batches of still-unlinked conversations.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = (await database.query(
      `SELECT id, sender, phone_number FROM conversations
        WHERE user_id = $1 AND customer_id IS NULL
        ORDER BY created_at ASC LIMIT $2`,
      [userId, batchSize],
    )).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const isLid = typeof row.sender === 'string' && row.sender.endsWith('@lid');
      const { customerId } = await resolver.resolveCustomer(userId, {
        phone: row.phone_number || (isLid ? null : row.sender),
        whatsappSender: isLid ? null : row.sender,
        whatsappLid: isLid ? row.sender : null,
        source: 'backfill_conversation',
      }, deps);
      await database.query('UPDATE conversations SET customer_id = $2 WHERE id = $1', [row.id, customerId]);
      touched.add(customerId);
      processed += 1;
    }
    if (rows.length < batchSize) break;
  }
  return { processed, customers: touched };
}

async function backfillCampaignContacts(userId, deps = {}) {
  const database = deps.database || db;
  const resolver = deps.resolver || defaultResolver;
  const batchSize = deps.batchSize || 500;
  const touched = new Set();
  let processed = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = (await database.query(
      `SELECT id, normalized_phone, sender FROM campaign_contacts
        WHERE user_id = $1 AND customer_id IS NULL
        ORDER BY created_at ASC LIMIT $2`,
      [userId, batchSize],
    )).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const { customerId } = await resolver.resolveCustomer(userId, {
        canonicalPhone: row.normalized_phone || null,
        whatsappSender: row.sender || null,
        source: 'backfill_campaign_contact',
      }, deps);
      await database.query('UPDATE campaign_contacts SET customer_id = $2 WHERE id = $1', [row.id, customerId]);
      touched.add(customerId);
      processed += 1;
    }
    if (rows.length < batchSize) break;
  }
  return { processed, customers: touched };
}

async function backfillUser(userId, deps = {}) {
  const metrics = deps.metrics || defaultMetrics;
  const conv = await backfillConversations(userId, deps);
  const cc = await backfillCampaignContacts(userId, deps);
  const all = new Set([...conv.customers, ...cc.customers]);
  for (const customerId of all) {
    try { await metrics.recomputeCustomer(userId, customerId, deps); } catch (_) { /* best-effort */ }
  }
  return { conversations: conv.processed, campaignContacts: cc.processed, customers: all.size };
}

module.exports = { backfillConversations, backfillCampaignContacts, backfillUser };
