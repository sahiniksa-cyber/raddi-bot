'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

// Stores the inbound message (transaction runs) and returns conv/msg ids — same
// fake used by message-grouping-config.test.js.
function createFakeDb() {
  return {
    isConfigured: () => true,
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
  const service = new MessageIngestService({
    database: createFakeDb(),
    logger: { info: () => {}, warn: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
    configLoader,
  });
  return { service, enqueued };
}

const BLOCKED_MSG = { id: { id: 'm1' }, from: '966501234567@s.whatsapp.net', body: 'مرحبا' };

test('blocked customer: message is stored (accepted) but NO AI reply is enqueued', async () => {
  const { service, enqueued } = makeService(async () => ({
    doNotReplyList: [{ number: '0501234567', name: 'عميل مزعج' }],
  }));

  const res = await service.ingestWhatsappMessage({ userId: 'u1', msg: BLOCKED_MSG, source: 'baileys' });

  assert.equal(enqueued.length, 0, 'blocked customer must NOT be enqueued for an AI reply');
  assert.equal(res.accepted, true, 'message must still be accepted/stored so it shows in the dashboard');
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

test('dashboard exposes a doNotReplyList control', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8');
  assert.ok(html.includes('doNotReplyList'), 'dashboard must contain a doNotReplyList control');
});
