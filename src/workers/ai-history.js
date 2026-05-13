'use strict';

function normalizeMemoryLimit(config = {}) {
  return Math.max(2, parseInt(config.memoryMessages, 10) || 50);
}

async function loadHistory(database, conversationId, limit) {
  const result = await database.query(
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  return result.rows
    .reverse()
    .map(row => ({ role: row.role, content: row.content }));
}

async function buildHistoryForReply({ database, conversationId, config, inboundText }) {
  const memSize = normalizeMemoryLimit(config);
  const history = await loadHistory(database, conversationId, memSize);
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
  loadHistory,
  normalizeMemoryLimit,
};
