'use strict';

const db = require('../../db/client');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function createPreActivation({ email, durationDays, messages, note, createdByAdmin }) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('email required');
  // durationDays empty/0/null = PERMANENT activation (no time limit). A positive
  // number = active for that many days. Independent of `messages`.
  let days = null;
  if (durationDays !== null && durationDays !== undefined && String(durationDays).trim() !== '') {
    const d = Math.floor(Number(durationDays));
    if (Number.isFinite(d) && d > 0) days = d;
  }
  const msgs = Math.max(0, Math.floor(Number(messages) || 0));

  // Replace any existing pending pre-activation for this email so the latest
  // admin instruction wins. We do this in a transaction to keep the partial
  // unique index (one unused row per email) consistent.
  return db.transaction(async (client) => {
    await client.query(
      `DELETE FROM pre_activations WHERE LOWER(email) = $1 AND used_at IS NULL`,
      [cleanEmail],
    );
    const result = await client.query(
      `INSERT INTO pre_activations (email, duration_days, messages, note, created_by_admin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, duration_days, messages, note, created_by_admin, created_at, used_at`,
      [cleanEmail, days, msgs, note || null, createdByAdmin || null],
    );
    return result.rows[0];
  });
}

async function listPreActivations({ includeUsed = false } = {}) {
  const where = includeUsed ? '' : 'WHERE used_at IS NULL';
  const result = await db.query(
    `SELECT id, email, duration_days, messages, note, created_by_admin, created_at, used_at, used_by_user_id
     FROM pre_activations
     ${where}
     ORDER BY created_at DESC
     LIMIT 200`,
  );
  return result.rows;
}

async function deletePreActivation({ id }) {
  const result = await db.query(
    `DELETE FROM pre_activations WHERE id = $1 AND used_at IS NULL`,
    [id],
  );
  return { deleted: result.rowCount > 0 };
}

async function consumePreActivationForUser({ client, email, userId }) {
  // Atomic consume: returns { durationDays, id } if a pending pre-activation
  // existed for this email, otherwise null. `client` is optional — when
  // provided the query runs on that pg client so it can be part of a
  // surrounding transaction.
  const lookup = client || db;
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return null;
  const result = await lookup.query(
    `UPDATE pre_activations
     SET used_at = NOW(), used_by_user_id = $2
     WHERE id = (
       SELECT id FROM pre_activations
       WHERE LOWER(email) = $1 AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE
     )
     RETURNING id, duration_days, messages`,
    [cleanEmail, userId],
  );
  if (!result.rows[0]) return null;
  return {
    id: result.rows[0].id,
    durationDays: result.rows[0].duration_days == null ? null : Number(result.rows[0].duration_days),
    messages: Number(result.rows[0].messages) || 0,
  };
}

module.exports = {
  createPreActivation,
  listPreActivations,
  deletePreActivation,
  consumePreActivationForUser,
  normalizeEmail,
};
