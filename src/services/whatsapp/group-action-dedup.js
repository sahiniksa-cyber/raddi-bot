'use strict';

/**
 * Idempotency for escalation-GROUP actions (prompt-edit, group status query).
 *
 * Group messages are handled and returned BEFORE the normal messages-table
 * insert, so — unlike customer messages — they never get the provider_message_id
 * dedup barrier. When WhatsApp re-delivers the same message (common during
 * connection churn / reconnects), the action runs again. Production 2026-08-04:
 * a single "تعديل" + "نعم" looped its propose/apply confirmation every ~minute
 * for ~10 minutes because each re-delivery re-executed the handler.
 *
 * claimGroupAction records the message id once. The first call returns true
 * (proceed); any later call for the same (user, message) returns false (skip).
 * Fail-OPEN: if the id is missing or the write errors, it returns true so a real
 * action is never silently dropped by the dedup layer.
 */

const dbDefault = require('../../db/client');

async function claimGroupAction(database, userId, messageId, action = 'group_action') {
  const db = database || dbDefault;
  if (!userId || !messageId) return true; // cannot dedup → allow (rare)
  try {
    const r = await db.query(
      `INSERT INTO whatsapp_group_action_dedup (user_id, message_id, action)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, message_id) DO NOTHING
       RETURNING message_id`,
      [userId, messageId, action],
    );
    return (r?.rows?.length || 0) > 0; // true = newly claimed (first delivery)
  } catch (_) {
    return true; // fail-open: never block a real action on a dedup error
  }
}

module.exports = { claimGroupAction };
