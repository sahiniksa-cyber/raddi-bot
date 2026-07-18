'use strict';

const crypto = require('crypto');
const { proto } = require('@whiskeysockets/baileys');

const db = require('../../db/client');

const ACTIVE_IMPORT_STATUSES = new Set(['starting', 'running']);
const DEFAULT_HISTORY_IMPORT_IDLE_MS = 3 * 60 * 1000;
const DEFAULT_HISTORY_IMPORT_MAX_MS = 15 * 60 * 1000;

function boundedDuration(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function historyImportIdleMs() {
  return boundedDuration(process.env.WA_HISTORY_IMPORT_IDLE_MS, DEFAULT_HISTORY_IMPORT_IDLE_MS, 30_000);
}

function historyImportMaxMs() {
  return boundedDuration(process.env.WA_HISTORY_IMPORT_MAX_MS, DEFAULT_HISTORY_IMPORT_MAX_MS, 60_000);
}

async function purgeTemporaryHistory(database, userId) {
  const messages = await database.query(
    `WITH deleted AS (
       DELETE FROM whatsapp_history_messages WHERE user_id = $1 RETURNING 1
     ) SELECT COUNT(*)::int AS count FROM deleted`,
    [userId],
  );
  const conversations = await database.query(
    `WITH deleted AS (
       DELETE FROM whatsapp_history_conversations WHERE user_id = $1 RETURNING 1
     ) SELECT COUNT(*)::int AS count FROM deleted`,
    [userId],
  );
  const messagesCount = Number(messages.rows[0]?.count || 0);
  const conversationsCount = Number(conversations.rows[0]?.count || 0);
  await database.query(
    `UPDATE whatsapp_history_imports SET
       purged_at = CASE WHEN $2::int > 0 OR $3::int > 0 THEN NOW() ELSE purged_at END,
       purged_messages_count = purged_messages_count + $2,
       purged_conversations_count = purged_conversations_count + $3,
       updated_at = NOW()
     WHERE id = (
       SELECT id FROM whatsapp_history_imports
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1
     )`,
    [userId, messagesCount, conversationsCount],
  );
  return { messages: messagesCount, conversations: conversationsCount };
}

async function rebuildCompactHistorySearchIndex(database, userId, importId = null) {
  const result = await database.query(
    `WITH source AS MATERIALIZED (
       SELECT
         m.user_id,
         m.sender,
         COALESCE(m.message_at, m.created_at)::date AS bucket_date,
         $2::uuid AS source_import_id,
         COALESCE(
           MAX(NULLIF(c.normalized_phone, '')),
           MAX(NULLIF(m.normalized_phone, ''))
         ) AS normalized_phone,
         COALESCE(MAX(NULLIF(c.customer_name, '')), '') AS customer_name,
         STRING_AGG(
           m.content,
           E'\n' ORDER BY COALESCE(m.message_at, m.created_at), m.provider_message_id
         ) AS search_document,
         COUNT(*)::int AS message_count,
         MIN(COALESCE(m.message_at, m.created_at)) AS first_message_at,
         MAX(COALESCE(m.message_at, m.created_at)) AS last_message_at
       FROM whatsapp_history_messages m
       LEFT JOIN whatsapp_history_conversations c
         ON c.user_id = m.user_id AND c.sender = m.sender
       WHERE m.user_id = $1
         AND m.direction = 'inbound'
         AND BTRIM(m.content) <> ''
       GROUP BY m.user_id, m.sender, COALESCE(m.message_at, m.created_at)::date
     ),
     indexed AS (
       INSERT INTO whatsapp_history_search_index (
         user_id, sender, bucket_date, source_import_id, normalized_phone,
         customer_name, search_document, message_count, first_message_at,
         last_message_at
       )
       SELECT
         user_id, sender, bucket_date, source_import_id, normalized_phone,
         customer_name, search_document, message_count, first_message_at,
         last_message_at
       FROM source
       ON CONFLICT (user_id, sender, bucket_date) DO UPDATE SET
         source_import_id = EXCLUDED.source_import_id,
         normalized_phone = COALESCE(EXCLUDED.normalized_phone, whatsapp_history_search_index.normalized_phone),
         customer_name = CASE
           WHEN EXCLUDED.customer_name <> '' THEN EXCLUDED.customer_name
           ELSE whatsapp_history_search_index.customer_name
         END,
         search_document = EXCLUDED.search_document,
         message_count = EXCLUDED.message_count,
         first_message_at = EXCLUDED.first_message_at,
         last_message_at = EXCLUDED.last_message_at,
         updated_at = NOW()
       RETURNING message_count, OCTET_LENGTH(search_document) AS document_bytes
     )
     SELECT
       COUNT(*)::int AS documents,
       COALESCE(SUM(message_count), 0)::int AS messages,
       COALESCE(SUM(document_bytes), 0)::bigint AS bytes
     FROM indexed`,
    [userId, importId],
  );
  const summary = result.rows[0] || {};
  return {
    documents: Number(summary.documents || 0),
    messages: Number(summary.messages || 0),
    bytes: Number(summary.bytes || 0),
  };
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.endsWith('@lid') || raw.endsWith('@g.us') || raw.includes('@broadcast')) return null;
  let digits = raw.replace(/@.*$/, '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 9) digits = `966${digits.slice(1)}`;
  if (!digits.startsWith('966') && digits.length === 9 && digits.startsWith('5')) digits = `966${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function isDirectChatJid(value) {
  const jid = String(value || '').trim();
  return !!jid && !jid.endsWith('@g.us') && !jid.includes('@broadcast') && jid !== 'status@broadcast';
}

function timestampToIso(value) {
  const numeric = Number(value?.toNumber?.() ?? value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(milliseconds).toISOString();
}

function historyMessageText(message = {}) {
  return String(
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    '',
  ).trim();
}

function deterministicHistoryMessageId({ sender, direction, messageAt, content }) {
  return `history:${crypto.createHash('sha256')
    .update(`${sender}\n${direction}\n${messageAt || ''}\n${content}`)
    .digest('hex')}`;
}

function syncTypeName(syncType) {
  return proto.HistorySync.HistorySyncType[syncType] || String(syncType ?? 'unknown');
}

function isMessageHistoryType(syncType) {
  const type = syncTypeName(syncType);
  return type === 'FULL' || type === 'RECENT' || type === 'ON_DEMAND';
}

function buildHistoryRows(event = {}) {
  const lidToPhone = new Map();
  for (const mapping of event.lidPnMappings || []) {
    const lid = String(mapping?.lid || mapping?.lidJid || '').trim();
    const phone = normalizePhone(mapping?.pn || mapping?.pnJid);
    if (lid && phone) lidToPhone.set(lid, phone);
  }

  const contacts = new Map();
  for (const contact of event.contacts || []) {
    const id = String(contact?.id || '').trim();
    if (!id || !isDirectChatJid(id)) continue;
    const phone = normalizePhone(contact?.phoneNumber || contact?.pnJid || id) ||
      lidToPhone.get(id) || null;
    const name = String(contact?.name || contact?.notify || contact?.verifiedName || '').trim().slice(0, 300);
    contacts.set(id, { phone, name });
    const lid = String(contact?.lid || contact?.lidJid || '').trim();
    if (lid && phone) lidToPhone.set(lid, phone);
  }

  const conversationMap = new Map();
  const ensureConversation = (sender, values = {}) => {
    if (!isDirectChatJid(sender)) return null;
    const existing = conversationMap.get(sender) || {
      sender,
      normalized_phone: null,
      customer_name: '',
      last_message_at: null,
      metadata: {},
    };
    const contact = contacts.get(sender) || {};
    existing.normalized_phone = existing.normalized_phone || values.normalized_phone || contact.phone ||
      lidToPhone.get(sender) || normalizePhone(sender);
    existing.customer_name = existing.customer_name || values.customer_name || contact.name || '';
    const candidateAt = values.last_message_at || null;
    if (candidateAt && (!existing.last_message_at || candidateAt > existing.last_message_at)) {
      existing.last_message_at = candidateAt;
    }
    conversationMap.set(sender, existing);
    return existing;
  };

  for (const chat of event.chats || []) {
    const sender = String(chat?.id || '').trim();
    ensureConversation(sender, {
      normalized_phone: normalizePhone(chat?.phoneNumber || chat?.pnJid) || lidToPhone.get(sender),
      customer_name: String(chat?.name || chat?.displayName || chat?.username || '').trim().slice(0, 300),
      last_message_at: timestampToIso(chat?.conversationTimestamp || chat?.lastMessageRecvTimestamp),
    });
  }

  const messages = [];
  for (const raw of event.messages || []) {
    const sender = String(raw?.key?.remoteJid || '').trim();
    if (!isDirectChatJid(sender)) continue;
    const direction = raw?.key?.fromMe ? 'outbound' : 'inbound';
    const content = historyMessageText(raw?.message || {});
    const messageAt = timestampToIso(raw?.messageTimestamp);
    const phone = normalizePhone(raw?.key?.senderPn || raw?.key?.participantPn) ||
      lidToPhone.get(sender) || contacts.get(sender)?.phone || normalizePhone(sender);
    ensureConversation(sender, { normalized_phone: phone, last_message_at: messageAt });
    if (!content) continue;
    const providerMessageId = String(raw?.key?.id || '').trim() || deterministicHistoryMessageId({
      sender,
      direction,
      messageAt,
      content,
    });
    messages.push({
      sender,
      normalized_phone: phone,
      direction,
      content: content.slice(0, 10000),
      provider_message_id: providerMessageId,
      message_at: messageAt,
      metadata: { source: 'whatsapp_history', fromMe: direction === 'outbound' },
    });
  }

  return { conversations: [...conversationMap.values()], messages };
}

class WhatsAppHistoryImportService {
  constructor({ database = db, userId, logger = console } = {}) {
    if (!userId) throw new Error('userId is required');
    this.db = database;
    this.userId = userId;
    this.logger = logger;
    this._queue = Promise.resolve();
  }

  async beginImport({ resumeAfterImport = false } = {}) {
    const active = await this.db.query(
      `SELECT id FROM whatsapp_history_imports
       WHERE user_id = $1 AND status IN ('starting','running')
       ORDER BY created_at DESC LIMIT 1`,
      [this.userId],
    );
    if (active.rows[0]) {
      const error = new Error('يوجد استيراد محادثات قيد التشغيل بالفعل');
      error.statusCode = 409;
      error.code = 'HISTORY_IMPORT_ACTIVE';
      throw error;
    }
    // Imported history is a temporary search index, not a second permanent
    // inbox. A new import replaces any unused older index for this merchant.
    await purgeTemporaryHistory(this.db, this.userId);
    const result = await this.db.query(
      `INSERT INTO whatsapp_history_imports (
         user_id, status, read_only, import_auth_state, resume_after_import
       ) VALUES ($1, 'starting', TRUE, '{}'::jsonb, $2) RETURNING *`,
      [this.userId, Boolean(resumeAfterImport)],
    );
    return result.rows[0];
  }

  async markRunning(importId) {
    const result = await this.db.query(
      `UPDATE whatsapp_history_imports
       SET status = 'running', last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'starting' RETURNING *`,
      [importId, this.userId],
    );
    if (!result.rows[0]) throw new Error('History import is not startable');
    return result.rows[0];
  }

  async markConnected(importId) {
    const result = await this.db.query(
      `UPDATE whatsapp_history_imports
       SET status = 'running', connected_at = COALESCE(connected_at, NOW()),
           sync_types = sync_types || $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('starting','running')
       RETURNING *`,
      [
        importId,
        this.userId,
        JSON.stringify({ connection: { status: 'connected', at: new Date().toISOString() } }),
      ],
    );
    return result.rows[0] || null;
  }

  enqueueHistorySet(importId, event) {
    const task = this._queue.catch(() => {}).then(() => this.ingestHistorySet(importId, event));
    this._queue = task;
    return task;
  }

  enqueueLiveUpsert(importId, event = {}) {
    return this.enqueueHistorySet(importId, {
      messages: event.messages || [],
      chats: [],
      contacts: [],
      lidPnMappings: [],
      syncType: 'LIVE_READ_ONLY',
      progress: null,
      isLatest: false,
    });
  }

  async ingestHistorySet(importId, event = {}) {
    const { conversations, messages } = buildHistoryRows(event);
    const type = syncTypeName(event.syncType);
    const numericProgress = Number(event.progress);
    const progress = Number.isFinite(numericProgress) ? Math.max(0, Math.min(100, Math.round(numericProgress))) : 0;
    const messageHistoryType = isMessageHistoryType(event.syncType);
    // In Baileys 7, isLatest means this notification is the newest one known
    // to the local credential state; it does NOT mean the final history chunk.
    // Finishing on isLatest truncated imports after the first batch. Only the
    // server's 100% progress (or messaging-history.status explicit completion)
    // is authoritative.
    const explicitlyComplete = messageHistoryType && progress >= 100;
    const effectiveProgress = messageHistoryType ? progress : 0;
    const syncDetail = {
      [type]: {
        progress: Number.isFinite(numericProgress) ? progress : null,
        isLatest: event.isLatest === true,
        lastEventAt: new Date().toISOString(),
      },
    };

    await this.db.transaction(async client => {
      const active = await client.query(
        `SELECT id FROM whatsapp_history_imports
         WHERE id = $1 AND user_id = $2 AND status IN ('starting','running') FOR UPDATE`,
        [importId, this.userId],
      );
      if (!active.rows[0]) return;

      if (conversations.length) {
        await client.query(
          `INSERT INTO whatsapp_history_conversations (
             user_id, last_import_id, sender, normalized_phone, customer_name,
             last_message_at, metadata
           )
           SELECT $1, $2, item.sender, item.normalized_phone, COALESCE(item.customer_name,''),
                  item.last_message_at, COALESCE(item.metadata,'{}'::jsonb)
           FROM jsonb_to_recordset($3::jsonb) AS item(
             sender text, normalized_phone text, customer_name text,
             last_message_at timestamptz, metadata jsonb
           )
           ON CONFLICT (user_id, sender) DO UPDATE SET
             last_import_id = EXCLUDED.last_import_id,
             normalized_phone = COALESCE(EXCLUDED.normalized_phone, whatsapp_history_conversations.normalized_phone),
             customer_name = CASE WHEN EXCLUDED.customer_name <> '' THEN EXCLUDED.customer_name ELSE whatsapp_history_conversations.customer_name END,
             last_message_at = CASE
               WHEN whatsapp_history_conversations.last_message_at IS NULL THEN EXCLUDED.last_message_at
               WHEN EXCLUDED.last_message_at IS NULL THEN whatsapp_history_conversations.last_message_at
               ELSE GREATEST(whatsapp_history_conversations.last_message_at, EXCLUDED.last_message_at)
             END,
             metadata = whatsapp_history_conversations.metadata || EXCLUDED.metadata,
             updated_at = NOW()`,
          [this.userId, importId, JSON.stringify(conversations)],
        );
      }

      if (messages.length) {
        await client.query(
          `INSERT INTO whatsapp_history_messages (
             user_id, import_id, sender, normalized_phone, direction, content,
             provider_message_id, message_at, metadata
           )
           SELECT $1, $2, item.sender, item.normalized_phone, item.direction,
                  COALESCE(item.content,''), item.provider_message_id, item.message_at,
                  COALESCE(item.metadata,'{}'::jsonb)
           FROM jsonb_to_recordset($3::jsonb) AS item(
             sender text, normalized_phone text, direction text, content text,
             provider_message_id text, message_at timestamptz, metadata jsonb
           )
           ON CONFLICT (user_id, provider_message_id) DO UPDATE SET
             import_id = EXCLUDED.import_id,
             normalized_phone = COALESCE(EXCLUDED.normalized_phone, whatsapp_history_messages.normalized_phone),
             metadata = whatsapp_history_messages.metadata || EXCLUDED.metadata`,
          [this.userId, importId, JSON.stringify(messages)],
        );
      }

      await client.query(
        `UPDATE whatsapp_history_imports SET
           status = 'running',
           progress = GREATEST(progress, $3),
           explicit_complete = explicit_complete OR $4,
           sync_types = sync_types || $5::jsonb,
           last_event_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [importId, this.userId, effectiveProgress, explicitlyComplete, JSON.stringify(syncDetail)],
      );
    });

    return {
      conversations: conversations.length,
      messages: messages.length,
      progress,
      type,
      explicitlyComplete,
    };
  }

  async recordHistoryStatus(importId, event = {}) {
    const type = syncTypeName(event.syncType);
    const complete = event.status === 'complete';
    const messageHistoryType = isMessageHistoryType(event.syncType);
    const explicit = messageHistoryType && complete && event.explicit === true;
    const detail = { [type]: { status: event.status || 'unknown', explicit, lastEventAt: new Date().toISOString() } };
    await this.db.query(
      `UPDATE whatsapp_history_imports SET
         progress = CASE WHEN $3 THEN 100 ELSE progress END,
         explicit_complete = explicit_complete OR $4,
         sync_types = sync_types || $5::jsonb,
         last_event_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('starting','running')`,
      [importId, this.userId, messageHistoryType && complete, explicit, JSON.stringify(detail)],
    );
    return { explicitlyComplete: explicit };
  }

  async finishImport(importId, { reason = 'manual' } = {}) {
    await this._queue.catch(() => {});
    const finishDetail = {
      autoFinish: {
        reason: String(reason || 'manual').slice(0, 80),
        at: new Date().toISOString(),
      },
    };
    const result = await this.db.query(
      `WITH imported AS (
         SELECT
           (SELECT COUNT(*)::int FROM whatsapp_history_conversations
            WHERE user_id = $2 AND last_import_id = $1) AS conversations,
           (SELECT COUNT(*)::int FROM whatsapp_history_messages
            WHERE user_id = $2 AND import_id = $1) AS messages
       )
       UPDATE whatsapp_history_imports i SET
         status = CASE
           WHEN imported.conversations = 0 AND imported.messages = 0 THEN 'failed'
           WHEN i.explicit_complete OR i.progress >= 100 THEN 'completed'
           ELSE 'partial'
         END,
         last_error = CASE
           WHEN imported.conversations = 0 AND imported.messages = 0
             THEN 'لم يرسل واتساب أي محادثات لهذه الجلسة. أعد الاستيراد وامسح رمز QR المؤقت من داخل خانة الحملات.'
           ELSE NULL
         END,
         import_auth_state = '{}'::jsonb,
         sync_types = i.sync_types || $3::jsonb,
         completed_at = NOW(), updated_at = NOW()
       FROM imported
       WHERE i.id = $1 AND i.user_id = $2 AND i.status IN ('starting','running')
       RETURNING i.*`,
      [importId, this.userId, JSON.stringify(finishDetail)],
    );
    const finished = result.rows[0] || null;
    if (finished && finished.status !== 'failed') {
      try {
        const indexed = await rebuildCompactHistorySearchIndex(this.db, this.userId, importId);
        if (indexed.messages > 0) {
          const purged = await purgeTemporaryHistory(this.db, this.userId);
          finished.search_index = indexed;
          finished.purged = purged;
        }
      } catch (error) {
        // Fail safe: keep raw history searchable if compacting fails. Never
        // delete the only searchable copy.
        this.logger.warn?.(`history search compaction failed; raw history retained: ${error.message}`);
      }
    }
    return finished;
  }

  async failImport(importId, error) {
    await this.db.query(
      `UPDATE whatsapp_history_imports SET status = 'failed', last_error = $3,
         import_auth_state = '{}'::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('starting','running')`,
      [importId, this.userId, String(error?.message || error || 'unknown').slice(0, 1000)],
    );
  }

  async latestStatus() {
    const result = await this.db.query(
      `SELECT i.*,
         (SELECT COUNT(*)::int FROM whatsapp_history_conversations c
          WHERE c.user_id = i.user_id AND c.last_import_id = i.id) AS conversations_total,
         (SELECT COUNT(*)::int FROM whatsapp_history_conversations c
          WHERE c.user_id = i.user_id AND c.last_import_id = i.id AND c.normalized_phone IS NOT NULL) AS numbers_total,
         (SELECT COUNT(*)::int FROM whatsapp_history_messages m
          WHERE m.user_id = i.user_id AND m.import_id = i.id) AS messages_total,
         (SELECT COUNT(*)::int FROM whatsapp_history_messages m
          WHERE m.user_id = i.user_id AND m.import_id = i.id AND m.direction = 'inbound') AS inbound_messages_total
         ,
         (SELECT COUNT(DISTINCT s.sender)::int FROM whatsapp_history_search_index s
          WHERE s.user_id = i.user_id) AS search_index_conversations_total,
         (SELECT COALESCE(SUM(s.message_count), 0)::int FROM whatsapp_history_search_index s
          WHERE s.user_id = i.user_id) AS search_index_messages_total,
         (SELECT COALESCE(SUM(OCTET_LENGTH(s.search_document)), 0)::bigint
          FROM whatsapp_history_search_index s
          WHERE s.user_id = i.user_id) AS search_index_bytes
       FROM whatsapp_history_imports i
       WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 1`,
      [this.userId],
    );
    const status = result.rows[0] || {
      status: 'not_started',
      progress: 0,
      explicit_complete: false,
      read_only: true,
      conversations_total: 0,
      numbers_total: 0,
      messages_total: 0,
      inbound_messages_total: 0,
    };
    const startedAt = status.started_at ? new Date(status.started_at).getTime() : null;
    if (startedAt && Number.isFinite(startedAt) && ACTIVE_IMPORT_STATUSES.has(status.status)) {
      status.auto_finish_at = new Date(startedAt + historyImportMaxMs()).toISOString();
      status.idle_timeout_seconds = Math.round(historyImportIdleMs() / 1000);
      const idleReference = status.last_event_at || status.connected_at;
      if (idleReference) {
        const idleAt = new Date(idleReference).getTime();
        if (Number.isFinite(idleAt)) status.idle_finish_at = new Date(idleAt + historyImportIdleMs()).toISOString();
      }
    }
    return status;
  }

  static isActiveStatus(status) {
    return ACTIVE_IMPORT_STATUSES.has(status);
  }
}

module.exports = {
  WhatsAppHistoryImportService,
  buildHistoryRows,
  historyImportIdleMs,
  historyImportMaxMs,
  historyMessageText,
  isDirectChatJid,
  isMessageHistoryType,
  normalizePhone,
  purgeTemporaryHistory,
  rebuildCompactHistorySearchIndex,
  timestampToIso,
};
