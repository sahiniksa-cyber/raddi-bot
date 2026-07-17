'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MessageIngestService,
  compactMediaForStorage,
} = require('../src/services/whatsapp/message-ingest.service');

function createFakeDb() {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id/.test(sql) && /conversations/.test(sql)) return { rows: [{ id: 'conv-1' }] };
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) return { rows: [{ id: 'msg-1' }] };
        return { rows: [] };
      },
    }),
  };
}

test('MessageIngestService accepts media-only inbound messages', async () => {
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
      id: { id: 'media-1' },
      from: '966500000000@s.whatsapp.net',
      body: '',
      hasMedia: true,
      type: 'imageMessage',
      media: {
        kind: 'image',
        mimeType: 'image/jpeg',
        data: Buffer.from('jpg').toString('base64'),
        caption: '',
      },
    },
    source: 'baileys',
  });

  assert.equal(result.accepted, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.hasMedia, true);
  assert.equal(enqueued[0].payload.media.kind, 'image');
  assert.match(database.calls[1].params[3], /\[صورة من العميل/);
});

test('terminal message storage keeps media metadata but removes base64 bytes', () => {
  const compact = compactMediaForStorage({
    kind: 'image',
    mimeType: 'image/jpeg',
    data: 'very-large-base64',
    base64: 'duplicate-large-base64',
    caption: 'فاتورة',
    sizeBytes: 1024,
  });
  assert.deepEqual(compact, {
    kind: 'image',
    mimeType: 'image/jpeg',
    caption: 'فاتورة',
    sizeBytes: 1024,
  });
});
