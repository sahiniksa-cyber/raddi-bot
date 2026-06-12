'use strict';

const db = require('../../db/client');
const { enqueueAiReply } = require('../../queues/message-queue');
const escalationBridge = require('../escalation/escalation-bridge');

function messageIdFromWhatsappMessage(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

function textFromWhatsappMessage(msg) {
  return String(msg?.body || '').trim();
}

function mediaFromWhatsappMessage(msg) {
  return msg?.media || null;
}

function mediaKindLabel(media) {
  const kind = String(media?.kind || media?.type || '').toLowerCase();
  const mimeType = String(media?.mimeType || media?.mimetype || '').toLowerCase();
  if (kind.includes('audio') || kind.includes('voice') || kind.includes('ptt') || mimeType.startsWith('audio/')) return 'رسالة صوتية من العميل';
  if (kind.includes('image') || mimeType.startsWith('image/')) return 'صورة من العميل';
  return 'ملف من العميل';
}

function contentFromWhatsappMessage(msg) {
  const text = textFromWhatsappMessage(msg);
  if (text) return text;
  const media = mediaFromWhatsappMessage(msg);
  if (!media) return '';
  return `[${mediaKindLabel(media)}]`;
}

function senderFromWhatsappMessage(msg) {
  return msg?.from || msg?.author || null;
}

function phoneNumberFromWhatsappMessage(msg) {
  const raw = String(msg?.phoneNumber || '').trim();
  return raw || null;
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
    media: mediaFromWhatsappMessage(msg),
    deviceType: msg?.deviceType || null,
  };
}

async function upsertConversation(client, { userId, sender, phoneNumber }) {
  const result = await client.query(
    `INSERT INTO conversations (user_id, sender, phone_number, last_message_at, metadata)
     VALUES ($1, $2, $3, NOW(), '{}'::jsonb)
     ON CONFLICT (user_id, sender) DO UPDATE SET
       last_message_at = NOW(),
       phone_number = COALESCE(conversations.phone_number, EXCLUDED.phone_number)
     RETURNING id, phone_number`,
    [userId, sender, phoneNumber],
  );
  return { id: result.rows[0].id, phoneNumber: result.rows[0].phone_number };
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

async function insertOutboundHumanMessage(client, { userId, conversationId, sender, text, providerMessageId, rawPayload }) {
  // Records a reply that the human owner sent from their own phone (fromMe=true) so
  // it shows up in the conversation history and so the AI never tries to answer it.
  const result = await client.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'sent_by_human', $6::jsonb)
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
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
  return result.rows[0]?.id || null;
}

function recipientFromFromMeMessage(msg) {
  // For fromMe messages, the customer is the recipient (remoteJid), not the author.
  const remoteJid = msg?.from || null;
  return remoteJid;
}

function isFromMeMessage(msg) {
  return msg?.fromMe === true;
}

const DEFAULT_OWNER_PAUSE_MINUTES = 30;

/**
 * Computes the timestamp until which the bot should stay muted on a conversation
 * after the owner replied manually. Returns null when pausing is disabled
 * (minutes <= 0 or not a finite number), so callers can skip the mute entirely.
 */
function ownerPauseExpiry(minutes, nowMs) {
  const m = parseInt(minutes, 10);
  if (!Number.isFinite(m) || m <= 0) return null;
  return new Date(nowMs + m * 60 * 1000);
}

class MessageIngestService {
  constructor({ logger = console, queue = { enqueueAiReply }, database = db, bridge = escalationBridge } = {}) {
    this.logger = logger;
    this.queue = queue;
    this.db = database;
    this.bridge = bridge;
  }

  /**
   * Escalation bridge: a message (group or 1:1, even fromMe) that QUOTES one
   * of our team-bound escalation messages is the team's solution — relay it
   * to the mapped customer instead of treating it as customer input. Returns
   * a result object when bridged, or null to fall through to normal handling.
   */
  async tryEscalationBridge({ userId, msg }) {
    const quotedId = msg?.quotedStanzaId;
    if (!quotedId || !this.db.isConfigured?.()) return null;
    try {
      const thread = await this.bridge.findThreadByQuotedId({ database: this.db, userId, quotedId });
      if (!thread) return null;
      const text = textFromWhatsappMessage(msg);
      if (!text) {
        this.logger.warn?.('bridge', 'quoted team reply has no text — skipped (send text, not media)');
        return { accepted: false, statusCode: 200, reason: 'bridge_empty_text' };
      }

      // A status QUESTION to the bot ("وش صار معاك") is answered back in the
      // GROUP — never relayed to the customer (production 2026-06-12).
      if (this.bridge.isThreadStatusQuery(text)) {
        const statusText = await this.bridge.buildThreadStatusReply({ database: this.db, userId, thread });
        await this.bridge.forwardCustomerReplyToTeam({
          userId,
          thread,
          customerSender: thread.customer_sender,
          text: statusText,
          raw: true,
        });
        this.logger.info?.('bridge', `answered a status query in the group for ${thread.customer_sender}`);
        return { accepted: true, statusCode: 200, bridged: true, statusQuery: true };
      }

      const result = await this.bridge.relayResolutionToCustomer({
        database: this.db,
        userId,
        thread,
        text,
        authorJid: msg.author || msg.from || null,
      });
      this.logger.info?.('bridge', `relayed team resolution to ${thread.customer_sender}`);
      return {
        accepted: true,
        statusCode: 200,
        bridged: true,
        relayed: !!result.relayed,
        customerSender: thread.customer_sender,
      };
    } catch (err) {
      this.logger.warn?.('bridge', `bridge check failed: ${err.message}`);
      return null; // fail-open: normal handling decides (groups stay ignored)
    }
  }

  shouldIgnore(msg) {
    if (!msg) return true;
    // NOTE: fromMe is NOT ignored here — it is handled by ingestOutboundHumanMessage.
    if (msg.from === 'status@broadcast') return true;
    if (String(msg.from || '').includes('@g.us')) return true;
    return !contentFromWhatsappMessage(msg);
  }

  async ingestWhatsappMessage({ userId, msg, source = 'whatsapp-web.js' }) {
    if (!userId) throw new Error('userId is required');
    if (!msg || msg.from === 'status@broadcast') {
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }

    // Escalation-bridge check runs BEFORE the group drop and the fromMe
    // routing: the team's quote-reply may arrive from a group, from a
    // contact's 1:1 chat, or from the owner's own phone (fromMe) inside the
    // group — all of them must reach the customer.
    const bridged = await this.tryEscalationBridge({ userId, msg });
    if (bridged) return bridged;

    if (String(msg?.from || '').includes('@g.us')) {
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }

    // Route fromMe messages to the outbound-human path: the owner replied manually
    // from their phone — record the message so it's in history and the AI knows
    // a human already answered, but never enqueue an AI reply.
    if (isFromMeMessage(msg)) {
      return this.ingestOutboundHumanMessage({ userId, msg, source });
    }

    if (this.shouldIgnore(msg)) {
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }
    if (!this.db.isConfigured()) {
      throw new Error('DATABASE_URL is required for message ingest');
    }

    const sender = senderFromWhatsappMessage(msg);
    const phoneNumber = phoneNumberFromWhatsappMessage(msg);
    const text = contentFromWhatsappMessage(msg);
    const media = mediaFromWhatsappMessage(msg);
    const providerMessageId = messageIdFromWhatsappMessage(msg) || `${userId}:${sender}:${Date.now()}`;
    const rawPayload = { source, ...toSafeRawPayload(msg) };

    const saved = await this.db.transaction(async (client) => {
      const { id: conversationId, phoneNumber: storedPhoneNumber } = await upsertConversation(client, {
        userId,
        sender,
        phoneNumber,
      });
      const messageId = await insertInboundMessage(client, {
        userId,
        conversationId,
        sender,
        text,
        providerMessageId,
        rawPayload,
      });
      return { conversationId, messageId, phoneNumber: storedPhoneNumber };
    });

    await this.queue.enqueueAiReply({
      userId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
      sender,
      phoneNumber: saved.phoneNumber,
      text,
      providerMessageId,
      source,
      hasMedia: !!media,
      media,
    }, {
      jobKey: `conversation-${saved.conversationId}`,
    });

    this.logger.info?.('message', `queued inbound message ${providerMessageId} from ${sender}`);

    // Active escalation thread (< window): the team owns this conversation —
    // forward the customer's reply to the group/contact so they can quote it
    // back. Fire-and-forget; a failure never affects normal ingestion.
    this.bridge.findActiveThreadForCustomer({ database: this.db, userId, customerSender: sender })
      .then((thread) => {
        if (!thread) return null;
        return this.bridge.forwardCustomerReplyToTeam({ userId, thread, customerSender: sender, text });
      })
      .then((fwd) => {
        if (fwd?.forwarded) this.logger.info?.('bridge', `forwarded customer reply from ${sender} to the team`);
      })
      .catch((err) => this.logger.warn?.('bridge', `customer forward failed: ${err.message}`));

    return {
      accepted: true,
      statusCode: 200,
      userId,
      sender,
      providerMessageId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
    };
  }

  /**
   * Reads the merchant's ownerPauseMinutes from bot_configs via a lightweight
   * direct query. Defaults to 30 when the row/value is missing or null.
   * Never throws — returns the default on any error.
   */
  async resolveOwnerPauseMinutes(userId) {
    try {
      const result = await this.db.query(
        `SELECT (config->>'ownerPauseMinutes') AS owner_pause_minutes
           FROM bot_configs WHERE user_id = $1`,
        [userId],
      );
      const raw = result?.rows?.[0]?.owner_pause_minutes;
      if (raw === null || raw === undefined) return DEFAULT_OWNER_PAUSE_MINUTES;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : DEFAULT_OWNER_PAUSE_MINUTES;
    } catch (_e) {
      return DEFAULT_OWNER_PAUSE_MINUTES;
    }
  }

  async ingestOutboundHumanMessage({ userId, msg, source = 'whatsapp-web.js' }) {
    if (!this.db.isConfigured()) {
      throw new Error('DATABASE_URL is required for message ingest');
    }

    // For fromMe messages: sender (conversation peer) is the recipient (remoteJid),
    // not the owner. The text comes from the same conversation/extendedText fields.
    const recipient = recipientFromFromMeMessage(msg);
    if (!recipient) {
      return { accepted: false, statusCode: 200, reason: 'from_me_no_recipient' };
    }
    const text = contentFromWhatsappMessage(msg);
    if (!text) {
      // No body and no media-derived label — nothing useful to store.
      return { accepted: false, statusCode: 200, reason: 'from_me_empty' };
    }
    const phoneNumber = phoneNumberFromWhatsappMessage(msg);
    const providerMessageId = messageIdFromWhatsappMessage(msg) || `${userId}:${recipient}:fromme:${Date.now()}`;
    const rawPayload = { source, fromMe: true, ...toSafeRawPayload(msg) };

    const saved = await this.db.transaction(async (client) => {
      const { id: conversationId, phoneNumber: storedPhoneNumber } = await upsertConversation(client, {
        userId,
        sender: recipient,
        phoneNumber,
      });
      const messageId = await insertOutboundHumanMessage(client, {
        userId,
        conversationId,
        sender: recipient,
        text,
        providerMessageId,
        rawPayload,
      });
      return { conversationId, messageId, phoneNumber: storedPhoneNumber };
    });

    this.logger.info?.('message', `recorded fromMe human reply ${providerMessageId} to ${recipient}`);

    // Owner replied manually → pause the bot on this conversation for a
    // configurable window (default 30min) by reusing the escalation-mute
    // mechanism (conversations.escalated_until). The AI worker already skips
    // muted conversations, so no worker change is needed. Wrapped in try/catch
    // so a failure here never breaks recording the owner's reply.
    try {
      const minutes = await this.resolveOwnerPauseMinutes(userId);
      const expiry = ownerPauseExpiry(minutes, Date.now());
      if (expiry && saved?.conversationId) {
        await this.db.query(
          `UPDATE conversations SET escalated_until = $2 WHERE id = $1`,
          [saved.conversationId, expiry],
        );
        this.logger.info?.('owner-pause', `paused bot on ${recipient} until ${expiry.toISOString()}`);
      }
    } catch (e) {
      this.logger?.warn?.('owner-pause', `failed to set pause: ${e.message}`);
    }

    return {
      accepted: true,
      statusCode: 200,
      userId,
      sender: recipient,
      providerMessageId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
      fromMe: true,
    };
  }
}

module.exports = {
  MessageIngestService,
  ownerPauseExpiry,
  messageIdFromWhatsappMessage,
  mediaFromWhatsappMessage,
  senderFromWhatsappMessage,
  textFromWhatsappMessage,
  contentFromWhatsappMessage,
};
