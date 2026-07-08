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
      });
    }
  }
  return out;
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
     RETURNING id, ai_paused`,
    [userId, item.participantId],
  );
  const conversationId = conv.rows[0].id;

  const inserted = await database.query(
    `INSERT INTO instagram_messages
       (conversation_id, user_id, participant_id, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1,$2,$3,'inbound','user',$4,$5,'queued_for_ai',$6::jsonb)
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conversationId, userId, item.participantId, item.text, item.mid, JSON.stringify(item)],
  );
  if (!inserted.rows[0]) return { duplicate: true };
  const messageId = inserted.rows[0].id;

  if (conv.rows[0].ai_paused) return { stored: true, aiPaused: true, messageId, conversationId };

  await enqueueAi(
    {
      userId,
      conversationId,
      messageId,
      participantId: item.participantId,
      text: item.text,
      providerMessageId: item.mid,
    },
    { jobKey: `ig-conversation-${conversationId}` },
  );

  return { stored: true, messageId, conversationId };
}

module.exports = { extractMessages, ingestWebhookEntry };
