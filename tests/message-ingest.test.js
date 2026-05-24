'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

function createFakeDb() {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id, phone_number/.test(sql) && /conversations/.test(sql)) {
          // Echo back the inserted phone_number to simulate the COALESCE returning the persisted value
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

test('ingest persists phoneNumber in conversations UPSERT with COALESCE', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm1' },
      from: '276282495500304@lid',
      phoneNumber: '966512345678',
      body: 'مرحبا',
    },
    source: 'baileys',
  });

  const upsert = database.calls.find(c => /INSERT INTO conversations/.test(c.sql));
  assert.ok(upsert, 'conversations UPSERT must run');
  assert.match(upsert.sql, /phone_number/);
  assert.match(upsert.sql, /COALESCE\(conversations\.phone_number, EXCLUDED\.phone_number\)/);
  assert.equal(upsert.params[2], '966512345678', 'phone_number must be the third param');
});

test('ingest forwards phoneNumber into the AI reply queue payload', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm2' },
      from: '276282495500304@lid',
      phoneNumber: '966512345678',
      body: 'hi',
    },
    source: 'baileys',
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.phoneNumber, '966512345678');
});

test('ingest accepts messages without phoneNumber (whatsapp-web.js path) and stores NULL', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm3' },
      from: '966500000000@s.whatsapp.net',
      body: 'hello',
    },
    source: 'whatsapp-web.js',
  });

  const upsert = database.calls.find(c => /INSERT INTO conversations/.test(c.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[2], null);
  assert.equal(enqueued[0].payload.phoneNumber, null);
});
