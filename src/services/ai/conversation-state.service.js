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

/**
 * Run one LLM extraction to update the semantic state from the customer's new
 * turns, then reconcile system-owned truth over it. Fail-soft on every path
 * (no client, throw, timeout, non-JSON) → returns the reconciled PRIOR state
 * with extraction_ok=false so the caller keeps it as a seed but never presents
 * it as current truth. Exactly one auxiliary LLM call per reply cycle.
 */
async function extractConversationState({
  userId, conversationId, previousState = {}, newTurns = [], lastBotReply = '',
  config = {}, aiClient, systemFacts = {}, timeoutMs,
} = {}) {
  const prior = validateState(previousState);
  try {
    if (!aiClient?.raw) throw new Error('no extraction client');
    const req = buildExtractionRequest({ previousState: prior, newTurns, lastBotReply });
    const limit = Number(timeoutMs || process.env.CONVERSATION_STATE_EXTRACT_TIMEOUT_MS || 9000);
    let timer;
    const resp = await Promise.race([
      aiClient.raw(req),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('extract timeout')), limit); }),
    ]).finally(() => clearTimeout(timer));
    const content = resp?.choices?.[0]?.message?.content || '';
    const { state, extraction_ok } = parseExtractionResponse(content);
    if (!extraction_ok) return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false };
    return { state: reconcileSystemState(state, systemFacts), extraction_ok: true };
  } catch (_) {
    return { state: reconcileSystemState(prior, systemFacts), extraction_ok: false };
  }
}

module.exports = { loadConversationState, saveConversationState, extractConversationState };
