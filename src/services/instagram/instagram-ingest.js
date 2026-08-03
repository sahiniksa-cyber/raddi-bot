'use strict';

/**
 * Instagram webhook ingest. Normalizes Meta's webhook payload into internal
 * message items, upserts the conversation (recording the 24h messaging
 * window), stores the inbound message idempotently (dedup by provider mid),
 * and enqueues an AI reply job. Instagram analog of message-ingest.service.js.
 *
 * Isolation: only touches instagram_* tables and the instagram queue.
 */

const db = require('../../db/client');
const { enqueueIncomingInstagram } = require('../../queues/instagram-queue');
const defaultAccounts = require('./instagram-accounts');
const defaultGraph = require('./instagram-graph');

// Classify a raw messaging event so logs can explain WHY an event produced no
// inbound text (echo / read receipt / reaction / attachment-only / postback),
// instead of a bare inboundCount:0 that looks identical to "Meta sent nothing".
function classifyEvent(m) {
  const message = m.message || {};
  if (message.is_echo) return 'echo';
  if (m.reaction) return 'reaction';
  if (m.read) return 'read';
  if (m.postback) return 'postback';
  if (message.text) return 'message';
  if (Array.isArray(message.attachments) && message.attachments.length) return 'attachment';
  return 'other';
}

function extractMessages(body) {
  const out = [];
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    const igAccountId = entry.id;
    const msgs = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const m of msgs) {
      const message = m.message || {};
      out.push({
        igAccountId,
        participantId: m.sender && m.sender.id,
        mid: message.mid,
        text: message.text || '',
        echo: Boolean(message.is_echo),
        timestamp: m.timestamp || null,
        type: classifyEvent(m),
      });
    }
  }
  return out;
}

// Count normalized events by type — used for a compact, safe webhook log line
// (no message content, no ids) that reveals what Meta is actually delivering.
function summarizeEventTypes(items) {
  const counts = {};
  for (const it of (items || [])) {
    const t = it && it.type ? it.type : 'other';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

async function ingestWebhookEntry(userId, item, deps = {}) {
  const database = deps.database || db;
  const enqueueAi = deps.enqueueAi || ((payload, opts) => enqueueIncomingInstagram(payload, opts));
  if (!item || item.echo || !item.text || !item.participantId) return { skipped: true };

  const conv = await database.query(
    `INSERT INTO instagram_conversations (user_id, participant_id, last_message_at, window_expires_at, status)
     VALUES ($1, $2, NOW(), NOW() + INTERVAL '24 hours', 'active')
     ON CONFLICT (user_id, participant_id) DO UPDATE
       SET last_message_at = NOW(), window_expires_at = NOW() + INTERVAL '24 hours'
     RETURNING id, ai_paused, (escalated_until IS NOT NULL AND escalated_until > NOW()) AS escalated`,
    [userId, item.participantId],
  );
  const conversationId = conv.rows[0].id;
  // A conversation is off-limits to the bot when it's explicitly ai_paused OR
  // currently under human takeover (escalated_until in the future) — a human
  // agent replied manually and must not be talked over.
  const aiPaused = Boolean(conv.rows[0].ai_paused || conv.rows[0].escalated);

  const inserted = await database.query(
    `INSERT INTO instagram_messages
       (conversation_id, user_id, participant_id, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1,$2,$3,'inbound','user',$4,$5,'queued_for_ai',$6::jsonb)
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conversationId, userId, item.participantId, item.text, item.mid, JSON.stringify(item)],
  );
  if (!inserted.rows[0]) {
    // A previous delivery may have stored the row and then failed while Redis
    // was unavailable. Meta will retry the webhook, so re-enqueue only while
    // the durable row is still waiting for AI. Without this recovery seam the
    // duplicate webhook was acknowledged but the message stayed stuck forever.
    const existing = await database.query(
      `SELECT id, conversation_id, status FROM instagram_messages
        WHERE user_id = $1 AND provider_message_id = $2`,
      [userId, item.mid],
    );
    const row = existing.rows[0];
    if (row && row.status === 'queued_for_ai' && !aiPaused) {
      await enqueueAi({
        userId,
        conversationId: row.conversation_id,
        messageId: row.id,
        participantId: item.participantId,
        text: item.text,
        providerMessageId: item.mid,
      });
      return { duplicate: true, requeued: true, messageId: row.id, conversationId: row.conversation_id };
    }
    return { duplicate: true };
  }
  const messageId = inserted.rows[0].id;

  if (aiPaused) {
    await database.query(
      `UPDATE instagram_messages SET status='ai_paused' WHERE id=$1 AND user_id=$2`,
      [messageId, userId],
    );
    return { stored: true, aiPaused: true, messageId, conversationId };
  }

  await enqueueAi(
    {
      userId,
      conversationId,
      messageId,
      participantId: item.participantId,
      text: item.text,
      providerMessageId: item.mid,
    },
    // The provider message id is the durable delivery id. A fixed
    // conversation job id remains in BullMQ after completion and used to block
    // every later DM in the same conversation.
    {},
  );

  return { stored: true, messageId, conversationId };
}

// Resolve and store the customer's @username for a conversation when it's still
// missing (Meta only sends the numeric IGSID). Best-effort: any failure returns
// null and leaves the conversation untouched. Called after ingest so the inbox
// shows @usernames instead of numeric ids.
async function ensureUsername(userId, participantId, deps = {}) {
  const database = deps.database || db;
  const accounts = deps.accounts || defaultAccounts;
  const graph = deps.graph || defaultGraph;
  if (!userId || !participantId) return null;
  const cur = await database.query(
    'SELECT participant_username FROM instagram_conversations WHERE user_id = $1 AND participant_id = $2',
    [userId, participantId],
  );
  if (cur.rows[0] && cur.rows[0].participant_username) return cur.rows[0].participant_username;
  let token = null;
  try { token = await accounts.getAccountToken(userId, { database }); } catch (_) { token = null; }
  if (!token) return null;
  let profile = {};
  try { profile = await graph.getUserProfile({ token, igsid: participantId }); } catch (_) { return null; }
  if (profile && profile.username) {
    await database.query(
      'UPDATE instagram_conversations SET participant_username = $3 WHERE user_id = $1 AND participant_id = $2',
      [userId, participantId, profile.username],
    );
    return profile.username;
  }
  return null;
}

module.exports = { extractMessages, ingestWebhookEntry, ensureUsername, classifyEvent, summarizeEventTypes };
