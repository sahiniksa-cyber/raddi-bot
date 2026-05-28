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
          return { rows: [{ id: 'conv-1', phone_number: params?.[2] ?? null }] };
        }
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) {
          return { rows: [{ id: 'msg-out-1' }] };
        }
        return { rows: [] };
      },
    }),
  };
}

test('fromMe=true message is stored as outbound+assistant+sent_by_human and NOT queued for AI', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  const result = await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'wamid-fromme-1' },
      from: '966555000111@s.whatsapp.net',
      fromMe: true,
      body: 'تم شحن طلبك',
    },
    source: 'baileys',
  });

  assert.equal(result.accepted, true);
  assert.equal(result.fromMe, true);
  assert.equal(enqueued.length, 0, 'AI queue must NOT be called for fromMe messages');

  const insert = database.calls.find(c => /INSERT INTO messages/.test(c.sql));
  assert.ok(insert, 'messages INSERT must run');
  assert.match(insert.sql, /'outbound'/);
  assert.match(insert.sql, /'assistant'/);
  assert.match(insert.sql, /'sent_by_human'/);
  assert.match(insert.sql, /ON CONFLICT[\s\S]*provider_message_id/);
  // params: [conversationId, userId, sender, text, providerMessageId, raw_payload]
  assert.equal(insert.params[2], '966555000111@s.whatsapp.net', 'sender must be the customer (remoteJid)');
  assert.equal(insert.params[3], 'تم شحن طلبك');
  assert.equal(insert.params[4], 'wamid-fromme-1');
});

test('fromMe with empty body is ignored', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (p, o) => enqueued.push({ p, o }) },
  });

  const result = await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'wamid-fromme-empty' },
      from: '966555000111@s.whatsapp.net',
      fromMe: true,
      body: '',
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(enqueued.length, 0);
});

test('fromMe=false still routes to inbound + AI queue', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (p, o) => enqueued.push({ p, o }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'wamid-inbound-1' },
      from: '966555000111@s.whatsapp.net',
      fromMe: false,
      body: 'مرحبا',
    },
  });

  assert.equal(enqueued.length, 1, 'inbound user message must enqueue AI reply');
  const insert = database.calls.find(c => /INSERT INTO messages/.test(c.sql));
  assert.match(insert.sql, /'inbound'/);
  assert.match(insert.sql, /'user'/);
});
