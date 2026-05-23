'use strict';

const PENDING_USER_STATUSES = new Set(['queued_for_ai', 'ai_failed']);
const UNSENT_ASSISTANT_STATUSES = new Set(['queued_for_send', 'expired', 'canceled', 'send_failed']);

function normalizeMemoryLimit(config = {}) {
  return Math.max(2, parseInt(config.memoryMessages, 10) || 50);
}

async function loadHistory(database, conversationId, limit) {
  const result = await database.query(
    `SELECT role, content, status, direction
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  return result.rows
    .reverse()
    .map(row => ({ role: row.role, content: row.content, status: row.status, direction: row.direction }));
}

function filterHistoryForAi(rows = []) {
  return rows.filter(row => {
    if (!row || !row.role) return false;
    if (row.role === 'assistant' && row.status && UNSENT_ASSISTANT_STATUSES.has(row.status)) return false;
    if (row.role === 'user' && row.status && PENDING_USER_STATUSES.has(row.status)) return false;
    return true;
  }).map(row => ({ role: row.role, content: row.content }));
}

async function buildHistoryForReply({ database, conversationId, config, inboundText }) {
  const memSize = normalizeMemoryLimit(config);
  const rawHistory = await loadHistory(database, conversationId, memSize);
  const history = filterHistoryForAi(rawHistory);
  const text = String(inboundText || '').trim();
  const last = history[history.length - 1];

  if (text && (!last || last.role !== 'user' || last.content !== text)) {
    history.push({ role: 'user', content: text });
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
