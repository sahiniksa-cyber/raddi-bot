'use strict';

const {
  classifyMessageSpeaker,
  normalizeSessionGapMs,
  trimToCurrentSession,
} = require('../services/ai/conversation-context');

const PENDING_USER_STATUSES = new Set(['queued_for_ai', 'ai_failed']);
const UNSENT_ASSISTANT_STATUSES = new Set(['queued_for_send', 'expired', 'canceled', 'send_failed']);

function normalizeMemoryLimit(config = {}) {
  return Math.max(2, parseInt(config.memoryMessages, 10) || 50);
}

async function loadHistory(
  database,
  conversationId,
  limit,
  userId,
  channelId = 'whatsapp',
  customerId,
) {
  if (!userId) throw new Error('userId is required for AI history');
  if (channelId !== 'whatsapp') throw new Error('invalid channelId for WhatsApp AI history');
  if (!customerId) throw new Error('customerId is required for AI history');

  const result = await database.query(
    `SELECT id, role, content, status, direction, raw_payload, created_at
     FROM messages
     WHERE conversation_id = $1
       AND user_id = $3
       AND channel_id = $4
       AND sender = $5
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [conversationId, limit, userId, channelId, customerId],
  );

  return result.rows
    .reverse()
    .map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      status: row.status,
      direction: row.direction,
      raw_payload: row.raw_payload,
      created_at: row.created_at,
    }));
}

function filterHistoryForAi(rows = []) {
  return rows.filter(row => {
    if (!row || !row.role) return false;
    if (row.role === 'assistant' && row.status && UNSENT_ASSISTANT_STATUSES.has(row.status)) return false;
    if (row.role === 'user' && row.status && PENDING_USER_STATUSES.has(row.status)) return false;
    return true;
  }).map(row => {
    const speaker = classifyMessageSpeaker(row);
    const content = String(row.content || '').trim();
    return {
      role: speaker === 'customer' ? 'user' : 'assistant',
      content: speaker === 'owner' ? `رسالة من مالك المتجر: ${content}` : content,
      // Carry the message's own timestamp so the reply layer can render per-turn
      // clock times. Additive: consumers that only read {role,content} ignore it.
      ts: row.created_at != null ? row.created_at : null,
    };
  }).filter(message => message.content);
}

async function buildHistoryForReply({
  database,
  conversationId,
  config,
  inboundText,
  userId,
  channelId = 'whatsapp',
  customerId,
}) {
  if (!userId) throw new Error('userId is required for AI history');
  const memSize = normalizeMemoryLimit(config);
  const rawHistory = await loadHistory(
    database,
    conversationId,
    memSize,
    userId,
    channelId,
    customerId,
  );
  const sessionGapMs = normalizeSessionGapMs(
    config?.historySessionGapMs ?? process.env.AI_HISTORY_SESSION_GAP_MS,
  );
  // Trim before filtering: the pending inbound row anchors the new session,
  // even though it is appended from inboundText rather than sent to the model
  // directly from the database.
  const history = filterHistoryForAi(trimToCurrentSession(rawHistory, sessionGapMs));
  const text = String(inboundText || '').trim();
  const last = history[history.length - 1];

  if (text && (!last || last.role !== 'user' || last.content !== text)) {
    // The pending inbound just arrived → its clock time is "now".
    history.push({ role: 'user', content: text, ts: new Date() });
  }
  if (history.length > memSize) history.splice(0, history.length - memSize);
  return history;
}

module.exports = {
  buildHistoryForReply,
  filterHistoryForAi,
  loadHistory,
  normalizeMemoryLimit,
};
