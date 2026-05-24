'use strict';

const db = require('../db/client');

const ACTIVE_WINDOW_MS = parseInt(process.env.CONVERSATION_ACTIVE_WINDOW_MS || String(30 * 60 * 1000), 10);

function classifyConversation(lastMessageAt, { now = Date.now(), activeWindowMs = ACTIVE_WINDOW_MS } = {}) {
  const ts = lastMessageAt ? new Date(lastMessageAt).getTime() : 0;
  return now - ts <= activeWindowMs ? 'ongoing' : 'finished';
}

function cleanCustomerPhone(senderOrRow) {
  if (senderOrRow && typeof senderOrRow === 'object') {
    const pn = String(senderOrRow.phone_number || '').trim();
    if (pn) return `+${pn}`;
    return cleanCustomerPhone(senderOrRow.sender);
  }
  const raw = String(senderOrRow || '').trim();
  if (raw.endsWith('@lid')) {
    const digits = raw.replace(/@lid$/, '').replace(/[^\d]/g, '');
    const last4 = digits.slice(-4);
    return last4 ? `عميل ····${last4}` : 'عميل قديم';
  }
  const digits = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}

function buildConversationTitle(text) {
  const cleaned = String(text || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'استفسار عميل';
  return cleaned.length > 70 ? `${cleaned.slice(0, 67)}...` : cleaned;
}

function normalizeMessage(row) {
  const media = row.raw_payload?.media || null;
  const kindRaw = String(media?.kind || media?.type || '').toLowerCase();
  let mediaKind = null;
  if (media) {
    if (kindRaw.includes('image') || String(media.mimeType || '').startsWith('image/')) mediaKind = 'image';
    else if (kindRaw === 'ptt') mediaKind = 'ptt';
    else if (kindRaw.includes('audio') || String(media.mimeType || '').startsWith('audio/')) mediaKind = 'audio';
    else if (kindRaw.includes('video')) mediaKind = 'video';
    else if (kindRaw.includes('document')) mediaKind = 'document';
    else mediaKind = kindRaw || 'other';
  }
  return {
    speaker: row.role === 'assistant' || row.direction === 'outbound' ? 'AI' : 'العميل',
    role: row.role,
    direction: row.direction,
    content: row.content || '',
    at: row.created_at,
    status: row.status || null,
    hasMedia: !!media,
    mediaKind,
  };
}

function createConversationsController({ database = db } = {}) {
  return {
    async list(req, res) {
      const userId = req.session.userId;
      const limit = Math.max(1, Math.min(50, parseInt(req.query?.limit, 10) || 20));
      const statusFilter = ['ongoing', 'finished'].includes(req.query?.status) ? req.query.status : 'all';
      const searchQuery = String(req.query?.q || '').trim();
      const now = Date.now();
      const cutoffIso = new Date(now - ACTIVE_WINDOW_MS).toISOString();

      const listParams = [userId];
      let statusCondition = '';
      if (statusFilter === 'ongoing') { statusCondition = ' AND c.last_message_at >= $2'; listParams.push(cutoffIso); }
      else if (statusFilter === 'finished') { statusCondition = ' AND c.last_message_at < $2'; listParams.push(cutoffIso); }

      let searchCondition = '';
      if (searchQuery) {
        listParams.push(`%${searchQuery}%`);
        const qPlaceholder = `$${listParams.length}`;
        searchCondition = ` AND (c.sender ILIKE ${qPlaceholder} OR EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.user_id = c.user_id
            AND m2.content ILIKE ${qPlaceholder}
        ))`;
      }

      listParams.push(limit);
      const limitPlaceholder = `$${listParams.length}`;

      // Counts and the list are independent — run them together.
      const [countsResult, conversations] = await Promise.all([
        database.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE last_message_at >= $2)::int AS ongoing,
                  COUNT(*) FILTER (WHERE last_message_at < $2)::int AS finished
           FROM conversations
           WHERE user_id = $1`,
          [userId, cutoffIso],
        ),
        database.query(
          `SELECT c.id,
                  c.sender,
                  c.phone_number,
                  c.last_message_at,
                  COALESCE(first_msg.content, '') AS first_inquiry
           FROM conversations c
           LEFT JOIN LATERAL (
             SELECT content
             FROM messages
             WHERE conversation_id = c.id
               AND user_id = c.user_id
               AND direction = 'inbound'
             ORDER BY created_at ASC
             LIMIT 1
           ) first_msg ON TRUE
           WHERE c.user_id = $1${statusCondition}${searchCondition}
           ORDER BY c.last_message_at DESC
           LIMIT ${limitPlaceholder}`,
          listParams,
        ),
      ]);
      const counts = countsResult.rows[0] || { total: 0, ongoing: 0, finished: 0 };

      const ids = conversations.rows.map(row => row.id);
      const messagesByConversation = new Map(ids.map(id => [id, []]));
      if (ids.length > 0) {
        const messages = await database.query(
          `SELECT conversation_id, role, direction, content, status, raw_payload, created_at
           FROM messages
           WHERE conversation_id = ANY($1::uuid[])
             AND user_id = $2
           ORDER BY created_at ASC`,
          [ids, userId],
        );
        for (const row of messages.rows) {
          messagesByConversation.get(row.conversation_id)?.push(normalizeMessage(row));
        }
      }

      const payload = conversations.rows.map(row => ({
        id: row.id,
        sender: row.sender,
        phoneNumber: row.phone_number || null,
        phone: cleanCustomerPhone(row),
        title: buildConversationTitle(row.first_inquiry),
        lastMessageAt: row.last_message_at,
        status: classifyConversation(row.last_message_at, { now }),
        messages: messagesByConversation.get(row.id) || [],
      }));

      res.json({
        success: true,
        total: counts.total,
        status: statusFilter,
        counts: { all: counts.total, ongoing: counts.ongoing, finished: counts.finished },
        conversations: payload,
      });
    },
  };
}

module.exports = {
  buildConversationTitle,
  classifyConversation,
  cleanCustomerPhone,
  createConversationsController,
  normalizeMessage,
};
