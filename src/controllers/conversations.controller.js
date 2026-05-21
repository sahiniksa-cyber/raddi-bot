'use strict';

const db = require('../db/client');

function cleanCustomerPhone(sender) {
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
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
  return {
    speaker: row.role === 'assistant' || row.direction === 'outbound' ? 'AI' : 'العميل',
    role: row.role,
    direction: row.direction,
    content: row.content || '',
    at: row.created_at,
  };
}

function createConversationsController({ database = db } = {}) {
  return {
    async list(req, res) {
      const userId = req.session.userId;
      const limit = Math.max(1, Math.min(50, parseInt(req.query?.limit, 10) || 20));
      const conversations = await database.query(
        `SELECT c.id,
                c.sender,
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
         WHERE c.user_id = $1
         ORDER BY c.last_message_at DESC
         LIMIT $2`,
        [userId, limit],
      );

      const ids = conversations.rows.map(row => row.id);
      const messagesByConversation = new Map(ids.map(id => [id, []]));
      if (ids.length > 0) {
        const messages = await database.query(
          `SELECT conversation_id, role, direction, content, created_at
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
        phone: cleanCustomerPhone(row.sender),
        title: buildConversationTitle(row.first_inquiry),
        lastMessageAt: row.last_message_at,
        messages: messagesByConversation.get(row.id) || [],
      }));

      res.json({
        success: true,
        total: payload.length,
        conversations: payload,
      });
    },
  };
}

module.exports = {
  buildConversationTitle,
  cleanCustomerPhone,
  createConversationsController,
};
