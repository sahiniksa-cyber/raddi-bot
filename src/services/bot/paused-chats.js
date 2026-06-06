'use strict';

/**
 * Owner-pause / escalation-mute query helpers.
 *
 * These back the dashboard "paused chats" panel. A conversation is considered
 * paused when `conversations.escalated_until > NOW()` (the same mechanism the
 * AI worker uses to skip generating replies). Both helpers are pure functions
 * over an injected `db` (anything with an async `query(sql, params)`), so they
 * are trivially unit-testable with a fake db.
 */

/**
 * Lists conversations currently paused (muted) for a merchant.
 * Returns `[{ sender, remainingMin }]` ordered by soonest-to-resume first.
 */
async function listPausedChats(db, userId) {
  const result = await db.query(
    `SELECT sender,
            CEIL(EXTRACT(EPOCH FROM (escalated_until - NOW())) / 60)::int AS remaining_min
       FROM conversations
      WHERE user_id = $1
        AND escalated_until IS NOT NULL
        AND escalated_until > NOW()
      ORDER BY escalated_until ASC`,
    [userId],
  );
  return (result?.rows || []).map((row) => ({
    sender: row.sender,
    remainingMin: row.remaining_min,
  }));
}

/**
 * Resumes the bot on paused conversations by clearing `escalated_until`.
 * When `sender` is provided, only that conversation is resumed; otherwise all
 * paused conversations for the merchant are resumed. Returns the number of
 * affected rows.
 */
async function resumePausedChat(db, userId, sender = null) {
  if (sender) {
    const result = await db.query(
      `UPDATE conversations
          SET escalated_until = NULL
        WHERE user_id = $1
          AND sender = $2`,
      [userId, sender],
    );
    return result?.rowCount || 0;
  }
  const result = await db.query(
    `UPDATE conversations
        SET escalated_until = NULL
      WHERE user_id = $1
        AND escalated_until IS NOT NULL`,
    [userId],
  );
  return result?.rowCount || 0;
}

module.exports = { listPausedChats, resumePausedChat };
