'use strict';

const crypto = require('node:crypto');

const db = require('../../db/client');
const { enqueueAiReply, enqueueOutgoingWhatsapp, resolveDebounceMs } = require('../../queues/message-queue');
const escalationBridge = require('../escalation/escalation-bridge');
const promptEditService = require('../prompt-edit/prompt-edit.service');
const { isCustomerBlocked } = require('./do-not-reply');
const { isAutoReplyEnabled } = require('../bot/auto-reply-control');

// Builds an AIClient bound to a merchant's config — used by the prompt-edit
// handler to smart-merge edits. Lazy-required to avoid a heavy import on the
// hot ingest path and to keep the module load cheap for tests.
async function defaultBuildPromptEditAiClient(userId, logger) {
  const AIClient = require('../../../lib/ai-client');
  const { resolveConfigForAI } = require('../bot/runtime-bot');
  const config = await resolveConfigForAI(userId);
  return new AIClient(config, logger);
}

// Lazy require to avoid a load-order circular dependency: runtime-bot transitively
// pulls in this service, so destructuring resolveConfigForAI at module load time
// can yield `undefined` when runtime-bot is required first. Resolve it at call time.
function defaultConfigLoader(userId) {
  return require('../bot/runtime-bot').resolveConfigForAI(userId);
}

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

function compactMediaForStorage(media) {
  if (!media || typeof media !== 'object') return media || null;
  const { data: _data, base64: _base64, ...metadata } = media;
  return metadata;
}

function toSafeRawPayload(msg, { includeMediaData = true } = {}) {
  const media = mediaFromWhatsappMessage(msg);
  return {
    id: messageIdFromWhatsappMessage(msg),
    from: msg?.from || null,
    to: msg?.to || null,
    author: msg?.author || null,
    timestamp: msg?.timestamp || null,
    type: msg?.type || null,
    hasMedia: !!msg?.hasMedia,
    media: includeMediaData ? media : compactMediaForStorage(media),
    deviceType: msg?.deviceType || null,
  };
}

async function upsertConversation(client, { userId, sender, phoneNumber }) {
  const result = await client.query(
    `INSERT INTO conversations (user_id, channel_id, sender, phone_number, last_message_at, metadata)
     VALUES ($1, 'whatsapp', $2, $3, NOW(), '{}'::jsonb)
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
    `INSERT INTO messages (conversation_id, user_id, channel_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, 'whatsapp', $3, 'inbound', 'user', $4, $5, 'queued_for_ai', $6::jsonb)
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
  if (result.rows[0]?.id) return { id: result.rows[0].id, inserted: true };

  const existing = await client.query(
    `SELECT id FROM messages
      WHERE user_id = $1
        AND provider_message_id = $2
        AND conversation_id = $3
        AND sender = $4
        AND channel_id = 'whatsapp'
      LIMIT 1`,
    [userId, providerMessageId, conversationId, sender],
  );
  if (!existing.rows[0]?.id) {
    const error = new Error('provider message id already exists outside the expected conversation scope');
    error.code = 'PROVIDER_MESSAGE_SCOPE_MISMATCH';
    throw error;
  }
  return { id: existing.rows[0].id, inserted: false };
}

async function insertOutboundHumanMessage(client, {
  userId,
  conversationId,
  sender,
  text,
  providerMessageId,
  rawPayload,
  occurredAt = null,
}) {
  // Records a reply that the human owner sent from their own phone (fromMe=true) so
  // it shows up in the conversation history and so the AI never tries to answer it.
  const result = await client.query(
    `INSERT INTO messages (conversation_id, user_id, channel_id, sender, direction, role, content, provider_message_id, status, raw_payload, created_at)
     VALUES ($1, $2, 'whatsapp', $3, 'outbound', 'assistant', $4, $5, 'sent_by_human', $6::jsonb, COALESCE($7::timestamptz, NOW()))
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id, created_at`,
    [
      conversationId,
      userId,
      sender,
      text,
      providerMessageId,
      JSON.stringify(rawPayload),
      occurredAt,
    ],
  );
  if (result.rows[0]?.id) {
    return {
      id: result.rows[0].id,
      createdAt: result.rows[0].created_at || occurredAt || new Date(),
      inserted: true,
    };
  }

  const existing = await client.query(
    `SELECT id, created_at FROM messages
      WHERE user_id = $1
        AND provider_message_id = $2
        AND conversation_id = $3
        AND sender = $4
        AND channel_id = 'whatsapp'
        AND direction = 'outbound'
      LIMIT 1`,
    [userId, providerMessageId, conversationId, sender],
  );
  if (!existing.rows[0]?.id) {
    const error = new Error('owner provider message id already exists outside the expected conversation scope');
    error.code = 'PROVIDER_MESSAGE_SCOPE_MISMATCH';
    throw error;
  }
  return {
    id: existing.rows[0].id,
    createdAt: existing.rows[0].created_at || null,
    inserted: false,
  };
}

function recipientFromFromMeMessage(msg) {
  // For fromMe messages, the customer is the recipient (remoteJid), not the author.
  const remoteJid = msg?.from || null;
  return remoteJid;
}

function isFromMeMessage(msg) {
  return msg?.fromMe === true;
}

function occurredAtFromWhatsappMessage(msg) {
  const value = Number(msg?.timestamp ?? msg?.messageTimestamp);
  const providerMs = Number.isFinite(value) && value > 0
    ? (value > 1_000_000_000_000 ? value : value * 1000)
    : null;
  const receivedMs = Number(msg?.receivedAt);
  const usePreciseReceiveTime = Number.isFinite(receivedMs) && receivedMs > 0 && (
    msg?.syncBatch !== true
    || (providerMs && Math.abs(receivedMs - providerMs) <= 10000)
  );
  const selectedMs = usePreciseReceiveTime ? receivedMs : providerMs;
  if (!Number.isFinite(selectedMs) || selectedMs <= 0) return null;
  const occurredAt = new Date(selectedMs);
  return Number.isNaN(occurredAt.getTime()) ? null : occurredAt;
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
  constructor({ logger = console, queue = { enqueueAiReply }, database = db, bridge = escalationBridge,
                configLoader = defaultConfigLoader,
                promptEdit = null, enqueueOutgoing = enqueueOutgoingWhatsapp, buildPromptEditAiClient = null,
                campaignSegmentation = null } = {}) {
    this.logger = logger;
    this.queue = queue;
    this.db = database;
    this.bridge = bridge;
    this.configLoader = configLoader;
    this.enqueueOutgoing = enqueueOutgoing;
    this.campaignSegmentation = campaignSegmentation;
    this.buildPromptEditAiClient = buildPromptEditAiClient
      || ((userId) => defaultBuildPromptEditAiClient(userId, logger));
    // Injectable handler: a function ({ userId, msg }) => resultObject|null.
    // Defaults to the real service wired with this instance's deps.
    this.promptEdit = promptEdit || (({ userId, msg }) => promptEditService.tryHandle({
      database: this.db,
      userId,
      msg,
      enqueue: this.enqueueOutgoing,
      buildAiClient: this.buildPromptEditAiClient,
      logger: this.logger,
    }));
  }

  /**
   * Status question in a thread-target group WITHOUT a quote — answers about
   * the group's most recent thread. Returns a result object or null.
   */
  async tryGroupStatusQuery({ userId, msg }) {
    const text = textFromWhatsappMessage(msg);
    if (!text || !this.bridge.isThreadStatusQuery(text)) return null;
    const thread = await this.bridge.findLatestThreadForTarget({
      database: this.db,
      userId,
      targetJid: msg.from,
    });
    if (!thread) return null;
    const statusText = await this.bridge.buildThreadStatusReply({ database: this.db, userId, thread });
    await this.bridge.forwardCustomerReplyToTeam({
      userId,
      thread,
      customerSender: thread.customer_sender,
      text: statusText,
      raw: true,
    });
    this.logger.info?.('bridge', `answered a no-quote status query in ${msg.from}`);
    return { accepted: true, statusCode: 200, bridged: true, statusQuery: true };
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

  async ingestWhatsappMessage({ userId, msg, source = 'baileys' }) {
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
      // Prompt-edit command from an escalation group (e.g. "تعديل: ..."). Runs
      // BEFORE the status query and the group drop, and is fail-open: any error
      // falls through to normal group handling so ingest never breaks.
      const editHandled = await Promise.resolve()
        .then(() => this.promptEdit({ userId, msg }))
        .catch((e) => { this.logger.warn?.('prompt-edit', `handler failed: ${e.message}`); return null; });
      if (editHandled) return editHandled;

      // No quote, but a status question inside a group that has recent
      // escalation threads ("وش صار" بدون اقتباس) — answer about the latest
      // thread instead of ignoring it (production 2026-06-12).
      const noQuoteStatus = await this.tryGroupStatusQuery({ userId, msg }).catch(() => null);
      if (noQuoteStatus) return noQuoteStatus;
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
    const providerMessageId = messageIdFromWhatsappMessage(msg)
      || `${userId}:${sender}:${Date.now()}:${crypto.randomUUID()}`;
    const rawPayload = { source, ...toSafeRawPayload(msg) };

    const saved = await this.db.transaction(async (client) => {
      const { id: conversationId, phoneNumber: storedPhoneNumber } = await upsertConversation(client, {
        userId,
        sender,
        phoneNumber,
      });
      const storedMessage = await insertInboundMessage(client, {
        userId,
        conversationId,
        sender,
        text,
        providerMessageId,
        rawPayload,
      });
      return {
        conversationId,
        messageId: storedMessage.id,
        inserted: storedMessage.inserted,
        phoneNumber: storedPhoneNumber,
      };
    });

    if (!saved.inserted) {
      this.logger.info?.('message', `duplicate inbound message ${providerMessageId} ignored`);
      return {
        accepted: true,
        statusCode: 200,
        userId,
        tenantId: userId,
        channelId: 'whatsapp',
        customerId: sender,
        sender,
        providerMessageId,
        conversationId: saved.conversationId,
        messageId: saved.messageId,
        reason: 'duplicate_provider_message',
        duplicate: true,
      };
    }

    // Campaign classification is a side channel on its own queue. It must
    // never slow down or break the normal customer-reply path. The worker reads
    // the complete recent conversation so a later "تم الطلب" message can move
    // an earlier product-interest row automatically.
    if (typeof this.campaignSegmentation === 'function') {
      Promise.resolve(this.campaignSegmentation({
        userId,
        conversationId: saved.conversationId,
        sender,
        messageId: saved.messageId,
      })).catch(error => this.logger.warn?.('campaign-segmentation', `enqueue failed: ${error.message}`));
    }

    // Resolve the per-merchant message-grouping window (debounce) AND the
    // do-not-reply list from the same config read. Fail-open: any config error
    // leaves delay at the global default and `blocked` false, so a bad/missing
    // config can never break ingest or silently block a customer.
    let delay;
    let blocked = false;
    let autoReplyEnabled = true;
    try {
      const cfg = await this.configLoader(userId);
      delay = resolveDebounceMs(cfg);
      blocked = isCustomerBlocked(cfg, sender, saved.phoneNumber || phoneNumber);
      autoReplyEnabled = isAutoReplyEnabled(cfg);
    } catch (_) {
      delay = resolveDebounceMs();
    }

    // Global auto-reply switch: store the customer's message and keep all
    // campaign classification data flowing, but do not create an AI job.
    // WhatsApp itself remains connected, so campaigns and manual sends keep
    // working. The terminal status prevents ai-recovery from answering later
    // when the merchant turns auto-reply back on.
    if (!autoReplyEnabled) {
      await this.db.query(
        `UPDATE messages SET status = 'auto_reply_disabled',
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) #- '{media,data}' #- '{media,base64}'
         WHERE id = $1
           AND user_id = $2
           AND conversation_id = $3
           AND sender = $4
           AND channel_id = 'whatsapp'`,
        [saved.messageId, userId, saved.conversationId, sender],
      );
      this.logger.info?.('message', `auto-reply disabled — inbound from ${sender} stored without AI enqueue`);
      return {
        accepted: true,
        statusCode: 200,
        userId,
        sender,
        providerMessageId,
        conversationId: saved.conversationId,
        messageId: saved.messageId,
        reason: 'auto_reply_disabled',
      };
    }

    // Do-not-reply: the merchant asked the bot to stay silent for this customer.
    // The message is already stored above (so it still shows in the dashboard),
    // we simply never enqueue an AI job — which means NO reply, NO escalation,
    // NO instant/auto reply (all of those live in the worker that never runs).
    if (blocked) {
      // Mark the stored row terminal so it is NOT queued_for_ai. Without this the
      // ai-recovery loop (which re-enqueues every queued_for_ai row within the
      // window) would answer the blocked customer ~30s later, defeating the
      // do-not-reply feature entirely.
      await this.db.query(
        `UPDATE messages SET status = 'do_not_reply',
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) #- '{media,data}' #- '{media,base64}'
         WHERE id = $1
           AND user_id = $2
           AND conversation_id = $3
           AND sender = $4
           AND channel_id = 'whatsapp'`,
        [saved.messageId, userId, saved.conversationId, sender],
      );
      this.logger.info?.('message', `inbound from ${sender} is on the do-not-reply list — stored, not answered`);
      return {
        accepted: true,
        statusCode: 200,
        userId,
        sender,
        providerMessageId,
        conversationId: saved.conversationId,
        messageId: saved.messageId,
        reason: 'do_not_reply',
      };
    }

    await this.queue.enqueueAiReply({
      userId,
      tenantId: userId,
      channelId: 'whatsapp',
      customerId: sender,
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
      delay,
    });

    this.logger.info?.('message', `queued inbound message ${providerMessageId} from ${sender}`);

    // REMOVED 2026-06-12 (owner's explicit, repeated demand): NO automatic
    // forwarding of customer messages to the group. It shuttled every single
    // customer message into the team chat — and self-extended its own window
    // with each forward. The group hears about a customer ONLY via
    // escalations/updates (when the AI can't handle it) and answers status
    // questions; the AI handles the normal conversation alone.

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

  /**
   * Decides whether THIS owner reply should pause the bot.
   * - ownerPausePhraseMode=false (default): ANY owner reply pauses.
   * - ownerPausePhraseMode=true: only replies CONTAINING a configured trigger
   *   phrase pause; casual messages let the bot keep chatting.
   * Never throws — fail-open to true (pause), the safer default.
   */
  async shouldOwnerReplyPause(userId, text) {
    try {
      const result = await this.db.query(
        `SELECT (config->>'ownerPausePhraseMode') AS mode, (config->'ownerPausePhrases') AS phrases
           FROM bot_configs WHERE user_id = $1`,
        [userId],
      );
      const row = result?.rows?.[0] || {};
      if (String(row.mode) !== 'true') return true; // mode off → any reply pauses
      let phrases = [];
      try { phrases = Array.isArray(row.phrases) ? row.phrases : JSON.parse(row.phrases || '[]'); } catch (_) { phrases = []; }
      const norm = (s) => String(s || '')
        .replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const t = norm(text);
      if (!t || !phrases.length) return false; // mode on but nothing to match → don't pause
      return phrases.some((p) => { const np = norm(p); return np && t.includes(np); });
    } catch (_e) {
      return true;
    }
  }

  /**
   * Applies the owner-pause to a conversation by recipient jid — used both by
   * the normal fromMe path and by media-only fromMe messages that carry no
   * storable text. Returns true when a pause was set.
   */
  async pauseConversationForOwner({ userId, recipient }) {
    const minutes = await this.resolveOwnerPauseMinutes(userId);
    const expiry = ownerPauseExpiry(minutes, Date.now());
    if (!expiry) return false;
    const result = await this.db.query(
      `INSERT INTO conversations (user_id, channel_id, sender, last_message_at)
       VALUES ($1, 'whatsapp', $2, NOW())
       ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
       RETURNING id`,
      [userId, recipient],
    );
    const conversationId = result.rows[0]?.id;
    if (!conversationId) return false;
    await this.db.query(
      `UPDATE conversations
          SET escalated_until = $2
        WHERE id = $1 AND user_id = $3 AND sender = $4`,
      [conversationId, expiry, userId, recipient],
    );
    this.logger.info?.('owner-pause', `paused bot on ${recipient} until ${expiry.toISOString()} (media-only owner reply)`);
    return true;
  }

  /**
   * True when this WhatsApp message id was sent by the BOT itself. Baileys
   * reserves every id in whatsapp_bot_send_ids before the network send, while
   * the outgoing worker also records delivered ids on messages. Used to avoid
   * mistaking a bot echo for an owner manual reply and self-pausing. Returns
   * null when ownership cannot be verified, so callers fail closed.
   */
  async isOwnBotSend({ userId, whatsappId }) {
    if (!userId || !whatsappId) return null;
    try {
      const r = await this.db.query(
        `SELECT 1
           FROM (
             SELECT whatsapp_message_id
               FROM messages
              WHERE user_id = $1
                AND whatsapp_message_id = $2
                AND direction = 'outbound'
             UNION ALL
             SELECT whatsapp_message_id
               FROM whatsapp_bot_send_ids
              WHERE user_id = $1
                AND whatsapp_message_id = $2
           ) bot_sends
          LIMIT 1`,
        [userId, whatsappId],
      );
      return r.rows.length > 0;
    } catch (error) {
      this.logger?.warn?.('from-me-ownership', `failed to verify WhatsApp send ownership: ${error.message}`);
      return null;
    }
  }

  async ingestOutboundHumanMessage({ userId, msg, source = 'baileys' }) {
    if (!this.db.isConfigured()) {
      throw new Error('DATABASE_URL is required for message ingest');
    }

    // For fromMe messages: sender (conversation peer) is the recipient (remoteJid),
    // not the owner. The text comes from the same conversation/extendedText fields.
    const recipient = recipientFromFromMeMessage(msg);
    if (!recipient) {
      return { accepted: false, statusCode: 200, reason: 'from_me_no_recipient' };
    }

    // CRITICAL: tell the OWNER's manual reply (which MUST pause the bot) apart
    // from the BOT's OWN outgoing message echoed back by WhatsApp as fromMe
    // (which must NOT pause — otherwise the bot silences itself after every
    // reply it sends). Baileys durably reserves the id before sending, so the
    // ownership lookup is valid even if the echo beats the worker's post-send
    // update of messages.whatsapp_message_id.
    const whatsappId = messageIdFromWhatsappMessage(msg);
    if (whatsappId) {
      const ownership = await this.isOwnBotSend({ userId, whatsappId });
      if (ownership === true) {
        return { accepted: true, statusCode: 200, reason: 'own_bot_echo', fromMe: true };
      }
      if (ownership === null) {
        return {
          accepted: false,
          statusCode: 503,
          reason: 'from_me_ownership_unverified',
          fromMe: true,
        };
      }
    }

    const text = contentFromWhatsappMessage(msg);
    if (!text) {
      // No body and no media-derived label — nothing useful to STORE, but the
      // owner still SENT something (image/file/sticker) to this customer, so
      // the 30-minute pause must apply anyway. Owner report 2026-06-12: the
      // bot kept replying right after the owner sent a media-only message.
      const paused = (await this.shouldOwnerReplyPause(userId, ''))
        ? await this.pauseConversationForOwner({ userId, recipient }).catch(() => false)
        : false;
      return { accepted: false, statusCode: 200, reason: 'from_me_empty', paused };
    }
    const phoneNumber = phoneNumberFromWhatsappMessage(msg);
    const providerMessageId = whatsappId
      || `${userId}:${recipient}:fromme:${Date.now()}:${crypto.randomUUID()}`;
    const rawPayload = {
      source,
      fromMe: true,
      ...toSafeRawPayload(msg, { includeMediaData: false }),
    };
    const occurredAt = occurredAtFromWhatsappMessage(msg);

    const saved = await this.db.transaction(async (client) => {
      const { id: conversationId, phoneNumber: storedPhoneNumber } = await upsertConversation(client, {
        userId,
        sender: recipient,
        phoneNumber,
      });
      const message = await insertOutboundHumanMessage(client, {
        userId,
        conversationId,
        sender: recipient,
        text,
        providerMessageId,
        rawPayload,
        occurredAt,
      });
      if (message.inserted) {
        await client.query(
          `UPDATE escalation_threads
              SET resolved_at = NOW()
            WHERE user_id = $1
              AND conversation_id = $2
              AND resolved_at IS NULL
              AND created_at <= $3`,
          [userId, conversationId, message.createdAt],
        );
      }
      return {
        conversationId,
        messageId: message.id,
        messageInserted: message.inserted,
        phoneNumber: storedPhoneNumber,
      };
    });

    if (!saved.messageInserted) {
      return {
        accepted: true,
        statusCode: 200,
        reason: 'duplicate_owner_message',
        fromMe: true,
        providerMessageId,
        conversationId: saved.conversationId,
        messageId: saved.messageId,
      };
    }

    this.logger.info?.('message', `recorded fromMe human reply ${providerMessageId} to ${recipient}`);

    // Owner replied manually → pause the bot on this conversation for a
    // configurable window (default 30min) by reusing the escalation-mute
    // mechanism (conversations.escalated_until). The AI worker already skips
    // muted conversations, so no worker change is needed. Wrapped in try/catch
    // so a failure here never breaks recording the owner's reply.
    try {
      // Only pause if this reply qualifies (phrase-mode aware).
      const shouldPause = await this.shouldOwnerReplyPause(userId, text);
      const minutes = shouldPause ? await this.resolveOwnerPauseMinutes(userId) : 0;
      const expiry = ownerPauseExpiry(minutes, Date.now());
      if (expiry && saved?.conversationId) {
        await this.db.query(
          `UPDATE conversations
              SET escalated_until = $2
            WHERE id = $1 AND user_id = $3 AND sender = $4`,
          [saved.conversationId, expiry, userId, recipient],
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
  compactMediaForStorage,
  insertInboundMessage,
  ownerPauseExpiry,
  messageIdFromWhatsappMessage,
  mediaFromWhatsappMessage,
  senderFromWhatsappMessage,
  textFromWhatsappMessage,
  contentFromWhatsappMessage,
};
