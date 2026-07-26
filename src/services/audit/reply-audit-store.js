'use strict';

const crypto = require('node:crypto');

function requireDatabase(database) {
  if (!database
      || typeof database.query !== 'function'
      || typeof database.transaction !== 'function') {
    throw new TypeError('An injected database with query and transaction is required');
  }
}

function createReplyAuditStore({
  database,
  randomUUID = crypto.randomUUID,
  now = () => new Date(),
}) {
  requireDatabase(database);

  async function append(event) {
    return database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [event.correlationId],
      );
      const sequence = await client.query(
        `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
         FROM reply_audit_events
         WHERE correlation_id = $1`,
        [event.correlationId],
      );
      const sequenceNo = Number(sequence.rows[0].next_sequence);
      const inserted = await client.query(
        `INSERT INTO reply_audit_events (
           id, correlation_id, sequence_no, user_id, conversation_id, customer_id,
           destination, send_class, stage, policy_version, content, content_hash,
           evidence_refs, violations, metadata, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13::jsonb, $14::jsonb, $15::jsonb, $16
         )
         RETURNING *`,
        [
          randomUUID(),
          event.correlationId,
          sequenceNo,
          event.userId,
          event.conversationId ?? null,
          event.customerId ?? null,
          event.destination,
          event.sendClass,
          event.stage,
          event.policyVersion,
          event.content ?? null,
          event.contentHash,
          JSON.stringify(event.evidenceRefs ?? []),
          JSON.stringify(event.violations ?? []),
          JSON.stringify(event.metadata ?? {}),
          now(),
        ],
      );
      return inserted.rows[0];
    });
  }

  async function reserveSend({
    userId,
    idempotencyKey,
    correlationId,
    destination,
    policyVersion,
    status = 'reserved',
    providerMessageId = null,
  }) {
    const timestamp = now();
    const inserted = await database.query(
      `INSERT INTO whatsapp_send_reservations (
         user_id, idempotency_key, correlation_id, destination, policy_version,
         status, provider_message_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        userId,
        idempotencyKey,
        correlationId,
        destination,
        policyVersion,
        status,
        providerMessageId,
        timestamp,
        timestamp,
      ],
    );
    if (inserted.rowCount > 0) {
      return { reserved: true, reservation: inserted.rows[0] };
    }

    const existing = await database.query(
      `SELECT * FROM whatsapp_send_reservations
       WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    if (existing.rowCount !== 1) {
      throw new Error('Reservation conflict did not resolve to a durable row');
    }
    if (existing.rows[0].status === 'retryable') {
      const reclaimed = await database.query(
        `UPDATE whatsapp_send_reservations
            SET correlation_id = $3,
                destination = $4,
                policy_version = $5,
                status = 'reserved',
                provider_message_id = NULL,
                updated_at = $6
          WHERE user_id = $1 AND idempotency_key = $2 AND status = 'retryable'
          RETURNING *`,
        [userId, idempotencyKey, correlationId, destination, policyVersion, timestamp],
      );
      if (reclaimed.rowCount === 1) {
        return { reserved: true, reservation: reclaimed.rows[0] };
      }
      const raced = await database.query(
        `SELECT * FROM whatsapp_send_reservations
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (raced.rowCount !== 1) throw new Error('Reservation reclaim race lost its durable row');
      return { reserved: false, reservation: raced.rows[0] };
    }
    return { reserved: false, reservation: existing.rows[0] };
  }

  async function markReservation({
    userId,
    idempotencyKey,
    status,
    providerMessageId = null,
  }) {
    const updated = await database.query(
      `UPDATE whatsapp_send_reservations
          SET status = $3,
              provider_message_id = COALESCE($4, provider_message_id),
              updated_at = $5
        WHERE user_id = $1 AND idempotency_key = $2
        RETURNING *`,
      [userId, idempotencyKey, status, providerMessageId, now()],
    );
    if (updated.rowCount !== 1) throw new Error('Durable send reservation is missing');
    return updated.rows[0];
  }

  return Object.freeze({
    append,
    markReservation,
    reserveSend,
  });
}

module.exports = {
  createReplyAuditStore,
};
