'use strict';

/**
 * I/O layer for the conversation-state engine (DB + LLM orchestration).
 * Every query is EXPLICITLY tenant-scoped by user_id — never relying on the
 * global uniqueness of conversation_id alone. All paths are fail-soft: a state
 * read/write/extract failure must never block a customer reply.
 */

const db = require('../../db/client');
const {
  EMPTY_STATE, validateState, buildExtractionRequest, parseExtractionResponse, reconcileSystemState,
} = require('./conversation-state');

async function loadConversationState({ userId, conversationId, database = db } = {}) {
  if (!userId || !conversationId || !database?.isConfigured?.()) {
    return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
  }
  try {
    const r = await database.query(
      `SELECT state, state_version, reflects_message_id, extraction_ok
         FROM conversation_states
        WHERE user_id = $1 AND conversation_id = $2
        LIMIT 1`,
      [userId, conversationId],
    );
    const row = r.rows[0];
    if (!row) return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
    return {
      state: validateState(row.state),
      extraction_ok: row.extraction_ok === true,
      reflects_message_id: row.reflects_message_id || null,
      state_version: Number(row.state_version) || 0,
    };
  } catch (_) {
    return { state: EMPTY_STATE, extraction_ok: false, reflects_message_id: null, state_version: 0 };
  }
}

async function saveConversationState({
  userId, conversationId, sender, channelId = 'whatsapp',
  state, extractionOk, reflectsMessageId = null, database = db,
} = {}) {
  if (!userId || !conversationId || !sender || !database?.isConfigured?.()) return;
  try {
    if (extractionOk) {
      await database.query(
        `INSERT INTO conversation_states
           (user_id, conversation_id, channel_id, sender, state, state_version, reflects_message_id, extraction_ok, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, TRUE, now())
         ON CONFLICT (user_id, conversation_id) DO UPDATE
           SET state = EXCLUDED.state,
               state_version = conversation_states.state_version + 1,
               reflects_message_id = EXCLUDED.reflects_message_id,
               extraction_ok = TRUE,
               updated_at = now()`,
        [userId, conversationId, channelId, sender, JSON.stringify(validateState(state)), reflectsMessageId],
      );
    } else {
      // Fail-soft: never persist a fresh state as truth on failure. Only flag it
      // so the injector knows the stored state is not current. Insert an empty
      // row if none exists yet (durable flag) but do NOT bump the version or
      // overwrite an existing good state.
      await database.query(
        `INSERT INTO conversation_states
           (user_id, conversation_id, channel_id, sender, extraction_ok, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, now())
         ON CONFLICT (user_id, conversation_id) DO UPDATE
           SET extraction_ok = FALSE, updated_at = now()`,
        [userId, conversationId, channelId, sender],
      );
    }
  } catch (_) { /* fail-soft: state persistence never blocks a reply */ }
}

module.exports = { loadConversationState, saveConversationState };
