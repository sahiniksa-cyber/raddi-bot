'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveDebounceMs } = require('../src/queues/message-queue');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

test('resolveDebounceMs uses per-merchant messageGroupingSeconds when present', () => {
  assert.equal(resolveDebounceMs({ messageGroupingSeconds: 30 }), 30000);
});

test('resolveDebounceMs clamps low values to 5s', () => {
  assert.equal(resolveDebounceMs({ messageGroupingSeconds: 3 }), 5000);
});

test('resolveDebounceMs clamps high values to 60s', () => {
  assert.equal(resolveDebounceMs({ messageGroupingSeconds: 999 }), 60000);
});

test('resolveDebounceMs returns the global default (30000) with no args', () => {
  assert.equal(resolveDebounceMs(), 30000);
});

test('resolveDebounceMs returns the global default for an empty config', () => {
  assert.equal(resolveDebounceMs({}), 30000);
});

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

test('ingest passes the per-merchant grouping window as the enqueue delay', async () => {
  const enqueued = [];
  const service = new MessageIngestService({
    database: createFakeDb(),
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
    configLoader: async () => ({ messageGroupingSeconds: 30 }),
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: { id: { id: 'm1' }, from: '276282495500304@lid', body: 'hi' },
    source: 'baileys',
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].options.delay, 30000);
  assert.equal(enqueued[0].options.jobKey, 'conversation-conv-1');
});

test('ingest fails open to the global default when configLoader throws', async () => {
  const enqueued = [];
  const service = new MessageIngestService({
    database: createFakeDb(),
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
    configLoader: async () => { throw new Error('db down'); },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: { id: { id: 'm2' }, from: '276282495500304@lid', body: 'hi' },
    source: 'baileys',
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].options.delay, 30000);
});

test('dashboard exposes a messageGroupingSeconds control', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8');
  assert.ok(html.includes('messageGroupingSeconds'), 'dashboard must contain messageGroupingSeconds');
});
