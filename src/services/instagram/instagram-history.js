'use strict';

/**
 * Build conversation history for the AI from instagram_messages. Mirrors
 * src/workers/ai-history.js but reads the Instagram table. Returns messages in
 * chronological order as [{ role, content }] for AIClient.getReply().
 */

const db = require('../../db/client');

async function buildInstagramHistory(conversationId, userId, config = {}, deps = {}) {
  const database = deps.database || db;
  const limit = Number(config.memoryMessages) || 50;
  const res = await database.query(
    `SELECT role, content, direction, status FROM instagram_messages
     WHERE conversation_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [conversationId, userId, limit],
  );
  return res.rows
    .filter((r) => r.content)
    .reverse()
    .map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
}

module.exports = { buildInstagramHistory };
