'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplyAuditStore } = require('../../src/services/audit/reply-audit-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonParameter(value) {
  return typeof value === 'string' ? JSON.parse(value) : clone(value);
}

function makeAuditDatabase() {
  const rows = [];
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params: clone(params) });
      if (/^SELECT pg_advisory_xact_lock/i.test(normalized)) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }
      if (/^SELECT COALESCE\(MAX\(sequence_no\), 0\) \+ 1 AS next_sequence/i.test(normalized)) {
        const matching = rows.filter((row) => row.correlation_id === params[0]);
        const next = matching.reduce((max, row) => Math.max(max, row.sequence_no), 0) + 1;
        return { rows: [{ next_sequence: next }], rowCount: 1 };
      }
      if (/^INSERT INTO reply_audit_events/i.test(normalized)) {
        const row = {
          id: params[0],
          correlation_id: params[1],
          sequence_no: params[2],
          user_id: params[3],
          conversation_id: params[4],
          customer_id: params[5],
          destination: params[6],
          send_class: params[7],
          stage: params[8],
          policy_version: params[9],
          content: params[10],
          content_hash: params[11],
          evidence_refs: parseJsonParameter(params[12]),
          violations: parseJsonParameter(params[13]),
          metadata: parseJsonParameter(params[14]),
          created_at: params[15],
        };
        rows.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };
  return {
    rows,
    calls,
    database: {
      query: client.query.bind(client),
      async transaction(work) {
        calls.push({ sql: 'BEGIN', params: [] });
        const result = await work(client);
        calls.push({ sql: 'COMMIT', params: [] });
        return result;
      },
    },
  };
}

test('append allocates a transactionally locked next sequence per correlation chain', async () => {
  const { database, calls } = makeAuditDatabase();
  let uuidCounter = 0;
  const store = createReplyAuditStore({
    database,
    randomUUID: () => `10000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });
  const event = {
    correlationId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    conversationId: null,
    customerId: 'customer-1',
    destination: '+966500000001',
    sendClass: 'reply',
    stage: 'reviewed',
    policyVersion: 'sha256:policy',
    content: 'first answer',
    contentHash: 'sha256:first',
    evidenceRefs: ['product-coffee'],
    violations: [],
    metadata: { attempt: 1 },
  };

  const first = await store.append(event);
  const second = await store.append({
    ...event,
    stage: 'sent',
    contentHash: 'sha256:second',
  });

  assert.equal(first.sequence_no, 1);
  assert.equal(second.sequence_no, 2);
  assert.equal(calls.filter((call) => call.sql === 'BEGIN').length, 2);
  assert.equal(
    calls.filter((call) => /^SELECT pg_advisory_xact_lock/i.test(call.sql)).length,
    2,
  );
  const firstInsert = calls.find((call) => /^INSERT INTO reply_audit_events/i.test(call.sql));
  assert.equal(firstInsert.params[12], '["product-coffee"]');
  assert.equal(firstInsert.params[13], '[]');
  assert.equal(firstInsert.params[14], '{"attempt":1}');
  assert.deepEqual(first.evidence_refs, ['product-coffee']);
  assert.deepEqual(first.metadata, { attempt: 1 });
});

test('audit store exposes append-only operations and no update or delete API', () => {
  const { database } = makeAuditDatabase();
  const store = createReplyAuditStore({ database });

  assert.deepEqual(Object.keys(store).sort(), ['append', 'reserveSend']);
  assert.equal(store.update, undefined);
  assert.equal(store.delete, undefined);
});
