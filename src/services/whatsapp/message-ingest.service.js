'use strict';

const db = require('../../db/client');
const { enqueueAiReply } = require('../../queues/message-queue');

function messageIdFromWhatsappMessage(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

function textFromWhatsappMessage(msg) {
  return String(msg?.body || '').trim();
}

function senderFromWhatsappMessage(msg) {
  return msg?.from || msg?.author || null;
}

function toSafeRawPayload(msg) {
  return {
    id: messageIdFromWhatsappMessage(msg),
    from: msg?.from || null,
    to: msg?.to || null,
    author: msg?.author || null,
    timestamp: msg?.timestamp || null,
    type: msg?.type || null,
    hasMedia: !!msg?.hasMedia,
    deviceType: msg?.deviceType || null,
  };
}

async function upsertConversation(client, { userId, sender }) {
  const result = await client.query(
    `INSERT INTO conversations (user_id, sender, last_message_at, metadata)
     VALUES ($1, $2, NOW(), '{}'::jsonb)
     ON CONFLICT (user_id, sender) DO UPDATE SET
       last_message_at = NOW()
     RETURNING id`,
    [userId, sender],
  );
  return result.rows[0].id;
}

async function insertInboundMessage(client, { userId, conversationId, sender, text, providerMessageId, rawPayload }) {
  const result = await client.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'inbound', 'user', $4, $5, 'queued_for_ai', $6::jsonb)
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO UPDATE SET
       status = CASE
         WHEN messages.status IN ('stored', 'queued_for_ai') THEN messages.status
         ELSE 'queued_for_ai'
       END
     RETURNING id`,
    [
      conversationId,
      userId,
      sender,
      text,
      providerMessageId,
      JSON.stringify(rawPayload),
    ],
  );
  return result.rows[0].id;
}

class MessageIngestService {
  constructor({ logger = console, queue = { enqueueAiReply }, database = db } = {}) {
    this.logger = logger;
    this.queue = queue;
    this.db = database;
  }

  shouldIgnore(msg) {
    if (!msg) return true;
    if (msg.fromMe) return true;
    if (msg.from === 'status@broadcast') return true;
    if (String(msg.from || '').includes('@g.us')) return true;
    return !textFromWhatsappMessage(msg);
  }

  async ingestWhatsappMessage({ userId, msg, source = 'whatsapp-web.js' }) {
    if (!userId) throw new Error('userId is required');
    if (this.shouldIgnore(msg)) {
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }
    if (!this.db.isConfigured()) {
      throw new Error('DATABASE_URL is required for message ingest');
    }

    const sender = senderFromWhatsappMessage(msg);
    const text = textFromWhatsappMessage(msg);
    const providerMessageId = messageIdFromWhatsappMessage(msg) || `${userId}:${sender}:${Date.now()}`;
    const rawPayload = { source, ...toSafeRawPayload(msg) };

    const saved = await this.db.transaction(async (client) => {
      const conversationId = await upsertConversation(client, { userId, sender });
      const messageId = await insertInboundMessage(client, {
        userId,
        conversationId,
        sender,
        text,
        providerMessageId,
        rawPayload,
      });

      return { conversationId, messageId };
    });

    await this.queue.enqueueAiReply({
      userId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
      sender,
      text,
      providerMessageId,
      source,
    }, {
      jobKey: String(saved.messageId),
    });

    this.logger.info?.('message', `queued inbound message ${providerMessageId} from ${sender}`);
    return {
      accepted: true,
      statusCode: 200,
      userId,
      sender,
      providerMessageId,
      ...saved,
    };
  }
}

module.exports = {
  MessageIngestService,
  messageIdFromWhatsappMessage,
  senderFromWhatsappMessage,
  textFromWhatsappMessage,
};
