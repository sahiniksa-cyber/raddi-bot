'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../../src/db/migrations/20260726-reply-audit');
const { createReplyAuditStore } = require('../../src/services/audit/reply-audit-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawJsonParameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function lossyTimestamp(value) {
  return new Date(value).toISOString();
}

function lossyAuditRow(row) {
  return {
    ...clone(row),
    evidence_refs: JSON.parse(row.evidence_refs),
    violations: JSON.parse(row.violations),
    metadata: JSON.parse(row.metadata),
    created_at: lossyTimestamp(row.created_at),
  };
}

function rawAuditSnapshotRow(row) {
  return clone(row);
}

function lossyReservationRow(row) {
  return {
    ...clone(row),
    created_at: lossyTimestamp(row.created_at),
    updated_at: lossyTimestamp(row.updated_at),
  };
}

function makeLocalSqlDatabase() {
  const state = {
    auditTable: false,
    reservationTable: false,
    auditRows: [],
    reservationRows: [],
  };
  const calls = [];

  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params: clone(params) });

      if (/^CREATE TABLE IF NOT EXISTS reply_audit_events/i.test(normalized)) {
        state.auditTable = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^CREATE TABLE IF NOT EXISTS whatsapp_send_reservations/i.test(normalized)) {
        state.reservationTable = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^LOCK TABLE (reply_audit_events|whatsapp_send_reservations)\b/i.test(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT id, correlation_id, sequence_no,[\s\S]+FROM reply_audit_events/i.test(
        normalized,
      )) {
        if (!state.auditTable) throw new Error('reply_audit_events does not exist');
        return {
          rows: state.auditRows.map(rawAuditSnapshotRow),
          rowCount: state.auditRows.length,
        };
      }
      if (/^SELECT \* FROM reply_audit_events ORDER BY/i.test(normalized)) {
        if (!state.auditTable) throw new Error('reply_audit_events does not exist');
        return {
          rows: state.auditRows.map(lossyAuditRow),
          rowCount: state.auditRows.length,
        };
      }
      if (/^SELECT user_id, idempotency_key,[\s\S]+FROM whatsapp_send_reservations/i.test(
        normalized,
      )) {
        if (!state.reservationTable) throw new Error('whatsapp_send_reservations does not exist');
        return { rows: clone(state.reservationRows), rowCount: state.reservationRows.length };
      }
      if (/^SELECT \* FROM whatsapp_send_reservations ORDER BY/i.test(normalized)) {
        if (!state.reservationTable) throw new Error('whatsapp_send_reservations does not exist');
        return {
          rows: state.reservationRows.map(lossyReservationRow),
          rowCount: state.reservationRows.length,
        };
      }
      if (/^DROP TABLE IF EXISTS whatsapp_send_reservations/i.test(normalized)) {
        state.reservationTable = false;
        state.reservationRows = [];
        return { rows: [], rowCount: 0 };
      }
      if (/^DROP TABLE IF EXISTS reply_audit_events/i.test(normalized)) {
        state.auditTable = false;
        state.auditRows = [];
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO reply_audit_events/i.test(normalized)) {
        const [
          id,
          correlationId,
          sequenceNo,
          userId,
          conversationId,
          customerId,
          destination,
          sendClass,
          stage,
          policyVersion,
          content,
          contentHash,
          evidenceRefs,
          violations,
          metadata,
          createdAt,
        ] = params;
        if (state.auditRows.some(
          (row) => row.correlation_id === correlationId && row.sequence_no === sequenceNo,
        )) {
          if (/DO NOTHING/i.test(normalized)) return { rows: [], rowCount: 0 };
          const error = new Error('duplicate audit sequence');
          error.code = '23505';
          throw error;
        }
        const row = {
          id,
          correlation_id: correlationId,
          sequence_no: sequenceNo,
          user_id: userId,
          conversation_id: conversationId,
          customer_id: customerId,
          destination,
          send_class: sendClass,
          stage,
          policy_version: policyVersion,
          content,
          content_hash: contentHash,
          evidence_refs: rawJsonParameter(evidenceRefs),
          violations: rawJsonParameter(violations),
          metadata: rawJsonParameter(metadata),
          created_at: createdAt,
        };
        state.auditRows.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (/^INSERT INTO whatsapp_send_reservations/i.test(normalized)) {
        const [
          userId,
          idempotencyKey,
          correlationId,
          destination,
          policyVersion,
          status,
          providerMessageId,
          createdAt,
          updatedAt,
        ] = params;
        const existing = state.reservationRows.find(
          (row) => row.user_id === userId && row.idempotency_key === idempotencyKey,
        );
        if (existing && /DO NOTHING/i.test(normalized)) {
          return { rows: [], rowCount: 0 };
        }
        if (existing) {
          const error = new Error('duplicate reservation');
          error.code = '23505';
          throw error;
        }
        const row = {
          user_id: userId,
          idempotency_key: idempotencyKey,
          correlation_id: correlationId,
          destination,
          policy_version: policyVersion,
          status,
          provider_message_id: providerMessageId,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        state.reservationRows.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (/^SELECT \* FROM whatsapp_send_reservations WHERE user_id = \$1/i.test(normalized)) {
        const row = state.reservationRows.find(
          (candidate) => candidate.user_id === params[0]
            && candidate.idempotency_key === params[1],
        );
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`Unexpected SQL in local fake: ${normalized}`);
    },
  };

  const database = {
    query: client.query.bind(client),
    async transaction(work) {
      const before = clone(state);
      calls.push({ sql: 'BEGIN', params: [] });
      try {
        const result = await work(client);
        calls.push({ sql: 'COMMIT', params: [] });
        return result;
      } catch (error) {
        Object.assign(state, before);
        calls.push({ sql: 'ROLLBACK', params: [] });
        throw error;
      }
    },
  };

  return { database, state, calls };
}

const auditRow = {
  id: '10000000-0000-4000-8000-000000000001',
  correlation_id: '20000000-0000-4000-8000-000000000001',
  sequence_no: 1,
  user_id: '30000000-0000-4000-8000-000000000001',
  conversation_id: '40000000-0000-4000-8000-000000000001',
  customer_id: 'customer-1',
  destination: '+966500000001',
  send_class: 'reply',
  stage: 'reviewed',
  policy_version: 'sha256:policy',
  content: 'answer',
  content_hash: 'sha256:content',
  evidence_refs: '["product-coffee"]',
  violations: '[]',
  metadata: '{"source":"test","counter":9007199254740993}',
  created_at: '2026-07-26 10:00:00.123456+00',
};

const reservationRow = {
  user_id: '30000000-0000-4000-8000-000000000001',
  idempotency_key: 'reply:1',
  correlation_id: '20000000-0000-4000-8000-000000000001',
  destination: '+966500000001',
  policy_version: 'sha256:policy',
  status: 'reserved',
  provider_message_id: null,
  created_at: '2026-07-26 10:00:00.123456+00',
  updated_at: '2026-07-26 10:00:01.654321+00',
};

async function insertFixtureRows(database) {
  await database.query(
    `INSERT INTO reply_audit_events (
       id, correlation_id, sequence_no, user_id, conversation_id, customer_id,
       destination, send_class, stage, policy_version, content, content_hash,
       evidence_refs, violations, metadata, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15::jsonb, $16
     )`,
    Object.values(auditRow),
  );
  await database.query(
    `INSERT INTO whatsapp_send_reservations (
       user_id, idempotency_key, correlation_id, destination, policy_version,
       status, provider_message_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    Object.values(reservationRow),
  );
}

test('up is idempotent and its statements are safely registered without running a database', async () => {
  const { database, state } = makeLocalSqlDatabase();

  await migration.up(database);
  await migration.up(database);

  assert.equal(state.auditTable, true);
  assert.equal(state.reservationTable, true);

  const init = require('../../src/db/migrations/init');
  for (const statement of migration.upStatements) {
    assert.equal(init.statements.includes(statement), true);
  }
});

test('up statements define the complete audit and tenant reservation schema contract', () => {
  assert.equal(migration.upStatements.length, 2);
  const [auditDdl, reservationDdl] = migration.upStatements.map(
    (statement) => statement.replace(/\s+/g, ' ').trim(),
  );
  const auditColumns = [
    'id UUID PRIMARY KEY',
    'correlation_id UUID NOT NULL',
    'sequence_no INTEGER NOT NULL',
    'user_id UUID NOT NULL',
    'conversation_id UUID',
    'customer_id TEXT',
    'destination TEXT NOT NULL',
    'send_class TEXT NOT NULL',
    'stage TEXT NOT NULL',
    'policy_version TEXT NOT NULL',
    'content TEXT',
    'content_hash TEXT NOT NULL',
    'evidence_refs JSONB NOT NULL',
    'violations JSONB NOT NULL',
    'metadata JSONB NOT NULL',
    'created_at TIMESTAMPTZ NOT NULL',
  ];
  const reservationColumns = [
    'user_id UUID NOT NULL',
    'idempotency_key TEXT NOT NULL',
    'correlation_id UUID NOT NULL',
    'destination TEXT NOT NULL',
    'policy_version TEXT NOT NULL',
    'status TEXT NOT NULL',
    'provider_message_id TEXT',
    'created_at TIMESTAMPTZ NOT NULL',
    'updated_at TIMESTAMPTZ NOT NULL',
  ];

  for (const column of auditColumns) assert.match(auditDdl, new RegExp(`\\b${column}\\b`, 'i'));
  for (const column of reservationColumns) {
    assert.match(reservationDdl, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(auditDdl, /UNIQUE \(correlation_id, sequence_no\)/i);
  assert.match(reservationDdl, /PRIMARY KEY \(user_id, idempotency_key\)/i);
  for (const nullableColumn of ['conversation_id UUID', 'customer_id TEXT', 'content TEXT']) {
    assert.doesNotMatch(auditDdl, new RegExp(`${nullableColumn} NOT NULL`, 'i'));
  }
  assert.doesNotMatch(reservationDdl, /provider_message_id TEXT NOT NULL/i);
});

test('down exports every row before the first destructive statement', async () => {
  const { database, state, calls } = makeLocalSqlDatabase();
  await migration.up(database);
  await insertFixtureRows(database);
  let preserved;

  await migration.down(database, {
    preservationSink: async (snapshot) => {
      calls.push({ sql: 'PRESERVE', params: [] });
      preserved = clone(snapshot);
    },
  });

  assert.deepEqual(preserved, {
    replyAuditEvents: [auditRow],
    whatsappSendReservations: [reservationRow],
  });
  assert.equal(state.auditTable, false);
  assert.equal(state.reservationTable, false);
  const preservationIndex = calls.findIndex((call) => call.sql === 'PRESERVE');
  const firstDropIndex = calls.findIndex((call) => /^DROP TABLE/i.test(call.sql));
  const auditLockIndex = calls.findIndex(
    (call) => call.sql === 'LOCK TABLE reply_audit_events IN ACCESS EXCLUSIVE MODE',
  );
  const reservationLockIndex = calls.findIndex(
    (call) => call.sql
      === 'LOCK TABLE whatsapp_send_reservations IN ACCESS EXCLUSIVE MODE',
  );
  const firstSnapshotRead = calls.findIndex(
    (call) => /FROM reply_audit_events ORDER BY correlation_id, sequence_no/i.test(call.sql),
  );
  const auditSnapshotSql = calls[firstSnapshotRead].sql;
  assert.match(auditSnapshotSql, /evidence_refs::text AS evidence_refs/i);
  assert.match(auditSnapshotSql, /violations::text AS violations/i);
  assert.match(auditSnapshotSql, /metadata::text AS metadata/i);
  assert.match(auditSnapshotSql, /created_at::text AS created_at/i);
  const reservationSnapshotSql = calls.find(
    (call) => /FROM whatsapp_send_reservations ORDER BY user_id, idempotency_key/i.test(
      call.sql,
    ),
  ).sql;
  assert.match(reservationSnapshotSql, /created_at::text AS created_at/i);
  assert.match(reservationSnapshotSql, /updated_at::text AS updated_at/i);
  assert.ok(auditLockIndex >= 0 && auditLockIndex < reservationLockIndex);
  assert.ok(reservationLockIndex < firstSnapshotRead);
  assert.ok(preservationIndex >= 0 && preservationIndex < firstDropIndex);
});

test('down refuses and rolls back before any destructive action when preservation fails', async () => {
  const { database, state, calls } = makeLocalSqlDatabase();
  await migration.up(database);
  await insertFixtureRows(database);

  await assert.rejects(
    migration.down(database, {
      preservationSink: async () => {
        throw new Error('preservation unavailable');
      },
    }),
    /preservation unavailable/,
  );

  assert.equal(state.auditTable, true);
  assert.equal(state.reservationTable, true);
  assert.deepEqual(state.auditRows, [auditRow]);
  assert.deepEqual(state.reservationRows, [reservationRow]);
  assert.equal(calls.some((call) => /^DROP TABLE/i.test(call.sql)), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('up insert down up restore preserves audit and reservation content', async () => {
  const { database, state, calls } = makeLocalSqlDatabase();
  await migration.up(database);
  await insertFixtureRows(database);
  let snapshot;
  await migration.down(database, {
    preservationSink: async (value) => {
      snapshot = clone(value);
    },
  });

  await migration.up(database);
  await migration.restore(database, snapshot);

  assert.deepEqual(state.auditRows, [auditRow]);
  assert.deepEqual(state.reservationRows, [reservationRow]);
  const restoredAuditInsert = calls
    .filter((call) => /^INSERT INTO reply_audit_events/i.test(call.sql))
    .at(-1);
  assert.equal(restoredAuditInsert.params[12], '["product-coffee"]');
  assert.equal(restoredAuditInsert.params[13], '[]');
  assert.equal(
    restoredAuditInsert.params[14],
    '{"source":"test","counter":9007199254740993}',
  );
  assert.equal(restoredAuditInsert.params[15], '2026-07-26 10:00:00.123456+00');
  assert.match(restoredAuditInsert.sql, /\$13::jsonb, \$14::jsonb, \$15::jsonb/);
  assert.match(restoredAuditInsert.sql, /\$16::timestamptz/i);
  const restoredReservationInsert = calls
    .filter((call) => /^INSERT INTO whatsapp_send_reservations/i.test(call.sql))
    .at(-1);
  assert.match(restoredReservationInsert.sql, /\$8::timestamptz, \$9::timestamptz/i);
  assert.equal(restoredReservationInsert.params[7], '2026-07-26 10:00:00.123456+00');
  assert.equal(restoredReservationInsert.params[8], '2026-07-26 10:00:01.654321+00');
});

test('restore rejects divergent rows instead of silently discarding preserved content', async () => {
  const { database, state } = makeLocalSqlDatabase();
  await migration.up(database);
  await insertFixtureRows(database);
  const divergent = {
    replyAuditEvents: [{
      ...auditRow,
      id: '10000000-0000-4000-8000-000000000099',
      content: 'preserved but different',
      content_hash: 'sha256:different',
    }],
    whatsappSendReservations: [],
  };

  await assert.rejects(
    migration.restore(database, divergent),
    /duplicate audit sequence/,
  );
  assert.deepEqual(state.auditRows, [auditRow]);
});

test('reservations are tenant scoped and same-tenant duplicates return the original row', async () => {
  const { database } = makeLocalSqlDatabase();
  await migration.up(database);
  const store = createReplyAuditStore({
    database,
    randomUUID: () => '20000000-0000-4000-8000-000000000099',
    now: () => new Date('2026-07-26T10:00:00.000Z'),
  });
  const base = {
    idempotencyKey: 'same-key',
    destination: '+966500000001',
    policyVersion: 'sha256:policy',
  };

  const tenantA = await store.reserveSend({
    ...base,
    userId: '30000000-0000-4000-8000-000000000001',
    correlationId: '20000000-0000-4000-8000-000000000001',
  });
  const tenantB = await store.reserveSend({
    ...base,
    userId: '30000000-0000-4000-8000-000000000002',
    correlationId: '20000000-0000-4000-8000-000000000002',
  });
  const duplicateA = await store.reserveSend({
    ...base,
    userId: '30000000-0000-4000-8000-000000000001',
    correlationId: '20000000-0000-4000-8000-000000000099',
  });

  assert.equal(tenantA.reserved, true);
  assert.equal(tenantB.reserved, true);
  assert.equal(duplicateA.reserved, false);
  assert.equal(
    duplicateA.reservation.correlation_id,
    '20000000-0000-4000-8000-000000000001',
  );
});
