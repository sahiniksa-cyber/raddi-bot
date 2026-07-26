'use strict';

const upStatements = [
  `CREATE TABLE IF NOT EXISTS reply_audit_events (
    id UUID PRIMARY KEY,
    correlation_id UUID NOT NULL,
    sequence_no INTEGER NOT NULL,
    user_id UUID NOT NULL,
    conversation_id UUID,
    customer_id TEXT,
    destination TEXT NOT NULL,
    send_class TEXT NOT NULL,
    stage TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    content TEXT,
    content_hash TEXT NOT NULL,
    evidence_refs JSONB NOT NULL,
    violations JSONB NOT NULL,
    metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (correlation_id, sequence_no)
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_send_reservations (
    user_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    correlation_id UUID NOT NULL,
    destination TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, idempotency_key)
  )`,
];

function requireDatabase(database) {
  if (!database || typeof database.transaction !== 'function') {
    throw new TypeError('An injected database with transaction(work) is required');
  }
}

function requireRawText(row, field) {
  if (typeof row[field] !== 'string') {
    throw new TypeError(`Preserved ${field} must be exact database text`);
  }
  return row[field];
}

async function up(database) {
  requireDatabase(database);
  return database.transaction(async (client) => {
    for (const statement of upStatements) {
      await client.query(statement);
    }
  });
}

async function down(database, { preservationSink } = {}) {
  requireDatabase(database);
  if (typeof preservationSink !== 'function') {
    throw new TypeError('A preservationSink is required before removing audit tables');
  }

  return database.transaction(async (client) => {
    await client.query('LOCK TABLE reply_audit_events IN ACCESS EXCLUSIVE MODE');
    await client.query('LOCK TABLE whatsapp_send_reservations IN ACCESS EXCLUSIVE MODE');
    const audit = await client.query(
      `SELECT id, correlation_id, sequence_no, user_id, conversation_id, customer_id,
              destination, send_class, stage, policy_version, content, content_hash,
              evidence_refs::text AS evidence_refs,
              violations::text AS violations,
              metadata::text AS metadata,
              created_at::text AS created_at
       FROM reply_audit_events
       ORDER BY correlation_id, sequence_no`,
    );
    const reservations = await client.query(
      `SELECT user_id, idempotency_key, correlation_id, destination, policy_version,
              status, provider_message_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at
       FROM whatsapp_send_reservations
       ORDER BY user_id, idempotency_key`,
    );

    await preservationSink({
      replyAuditEvents: audit.rows,
      whatsappSendReservations: reservations.rows,
    });

    await client.query('DROP TABLE IF EXISTS whatsapp_send_reservations');
    await client.query('DROP TABLE IF EXISTS reply_audit_events');
  });
}

async function restore(database, snapshot) {
  requireDatabase(database);
  if (!snapshot
      || !Array.isArray(snapshot.replyAuditEvents)
      || !Array.isArray(snapshot.whatsappSendReservations)) {
    throw new TypeError('A complete preserved audit snapshot is required');
  }

  return database.transaction(async (client) => {
    for (const row of snapshot.replyAuditEvents) {
      await client.query(
        `INSERT INTO reply_audit_events (
           id, correlation_id, sequence_no, user_id, conversation_id, customer_id,
           destination, send_class, stage, policy_version, content, content_hash,
           evidence_refs, violations, metadata, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13::jsonb, $14::jsonb, $15::jsonb, $16::timestamptz
         )`,
        [
          row.id,
          row.correlation_id,
          row.sequence_no,
          row.user_id,
          row.conversation_id,
          row.customer_id,
          row.destination,
          row.send_class,
          row.stage,
          row.policy_version,
          row.content,
          row.content_hash,
          requireRawText(row, 'evidence_refs'),
          requireRawText(row, 'violations'),
          requireRawText(row, 'metadata'),
          requireRawText(row, 'created_at'),
        ],
      );
    }

    for (const row of snapshot.whatsappSendReservations) {
      await client.query(
        `INSERT INTO whatsapp_send_reservations (
           user_id, idempotency_key, correlation_id, destination, policy_version,
           status, provider_message_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz
         )`,
        [
          row.user_id,
          row.idempotency_key,
          row.correlation_id,
          row.destination,
          row.policy_version,
          row.status,
          row.provider_message_id,
          requireRawText(row, 'created_at'),
          requireRawText(row, 'updated_at'),
        ],
      );
    }
  });
}

module.exports = {
  down,
  restore,
  up,
  upStatements,
};
