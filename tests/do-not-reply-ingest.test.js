'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

// Stores the inbound message (transaction runs) and returns conv/msg ids — same
// fake used by message-grouping-config.test.js. `topLevelQueries` captures any
// query run OUTSIDE the transaction (e.g. the do-not-reply status update).
function createFakeDb(topLevelQueries) {
  return {
    isConfigured: () => true,
    query: async (sql, params) => {
      topLevelQueries.push({ sql, params });
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        if (/RETURNING id, phone_number/.test(sql) && /conversations/.test(sql)) {
          return { rows: [{ id: 'conv-1', phone_number: params?.[2] ?? null }] };
        }
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) {
          return { rows: [{ id: 'msg-1' }] };
        }
        return { rows: [] };
      },
    }),
  };
}

function makeService(configLoader) {
  const enqueued = [];
  const topLevelQueries = [];
  const service = new MessageIngestService({
    database: createFakeDb(topLevelQueries),
    logger: { info: () => {}, warn: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
    configLoader,
  });
  return { service, enqueued, topLevelQueries };
}

const BLOCKED_MSG = { id: { id: 'm1' }, from: '966501234567@s.whatsapp.net', body: 'مرحبا' };

test('blocked customer: message is stored (accepted) but NO AI reply is enqueued', async () => {
  const { service, enqueued, topLevelQueries } = makeService(async () => ({
    doNotReplyList: [{ number: '0501234567', name: 'عميل مزعج' }],
  }));

  const res = await service.ingestWhatsappMessage({ userId: 'u1', msg: BLOCKED_MSG, source: 'baileys' });

  assert.equal(enqueued.length, 0, 'blocked customer must NOT be enqueued for an AI reply');
  assert.equal(res.accepted, true, 'message must still be accepted/stored so it shows in the dashboard');
  // The stored row must be marked terminal so the ai-recovery loop never
  // re-enqueues (and answers) the blocked customer ~30s later.
  const marked = topLevelQueries.find((q) => /UPDATE messages SET status = 'do_not_reply'/.test(q.sql));
  assert.ok(marked, 'blocked inbound row must be marked do_not_reply');
  assert.deepEqual(marked.params, ['msg-1', 'u1']);
});

test('non-blocked customer: AI reply is still enqueued normally', async () => {
  const { service, enqueued } = makeService(async () => ({
    doNotReplyList: [{ number: '0509999999', name: 'someone else' }],
  }));

  await service.ingestWhatsappMessage({ userId: 'u1', msg: BLOCKED_MSG, source: 'baileys' });

  assert.equal(enqueued.length, 1, 'a customer who is not on the list must be answered');
});

test('fail-open: if config cannot be read, the customer is NOT blocked (bot keeps working)', async () => {
  const { service, enqueued } = makeService(async () => { throw new Error('config db down'); });

  await service.ingestWhatsappMessage({ userId: 'u1', msg: BLOCKED_MSG, source: 'baileys' });

  assert.equal(enqueued.length, 1, 'a config error must never silently block a customer');
});

test('global auto-reply off stores inbound but never queues AI', async () => {
  const { service, enqueued, topLevelQueries } = makeService(async () => ({
    autoReplyEnabled: false,
    doNotReplyList: [],
  }));

  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: BLOCKED_MSG,
    source: 'baileys',
  });

  assert.equal(res.accepted, true);
  assert.equal(res.reason, 'auto_reply_disabled');
  assert.equal(enqueued.length, 0);
  const marked = topLevelQueries.find(query =>
    /UPDATE messages SET status = 'auto_reply_disabled'/.test(query.sql));
  assert.ok(marked, 'disabled auto-reply must be terminal so recovery cannot answer later');
  assert.deepEqual(marked.params, ['msg-1', 'u1']);
});

test('global auto-reply defaults on when the merchant never used the switch', async () => {
  const { service, enqueued } = makeService(async () => ({
    doNotReplyList: [],
  }));

  await service.ingestWhatsappMessage({ userId: 'u1', msg: BLOCKED_MSG, source: 'baileys' });

  assert.equal(enqueued.length, 1);
});

test('dashboard exposes a doNotReplyList control', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8');
  assert.ok(html.includes('doNotReplyList'), 'dashboard must contain a doNotReplyList control');
});
