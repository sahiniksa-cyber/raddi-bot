'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
const { EnterpriseWhatsAppConnectionManager } = require('../src/services/whatsapp/connection-manager');

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

test('Baileys manager downloads image media before ingesting', async () => {
  const ingested = [];
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ingestService: {
      ingestWhatsappMessage: async (payload) => {
        ingested.push(payload);
        return { accepted: true };
      },
    },
    mediaDownloader: async () => Buffer.from('image-bytes'),
  });

  manager._running = true;
  manager.acceptMessagesAfterMs = Date.now() - 5_000;
  await manager.handleMessages({
    type: 'notify',
    messages: [{
      key: { id: 'img-1', remoteJid: '966501234567@s.whatsapp.net' },
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'كم سعره؟' } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }],
  });

  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].msg.media.kind, 'image');
  assert.equal(ingested[0].msg.media.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(ingested[0].msg.media.data, 'base64').toString(), 'image-bytes');
});

test('Enterprise WhatsApp manager downloads media before ingesting', async () => {
  const ingested = [];
  const manager = new EnterpriseWhatsAppConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ingestService: {
      ingestWhatsappMessage: async (payload) => {
        ingested.push(payload);
        return { accepted: true };
      },
    },
  });

  await manager.handleIncomingMessage({
    id: { id: 'voice-1' },
    from: '966501234567@c.us',
    body: '',
    hasMedia: true,
    type: 'ptt',
    timestamp: Math.floor(Date.now() / 1000),
    downloadMedia: async () => ({
      mimetype: 'audio/ogg; codecs=opus',
      data: Buffer.from('voice-bytes').toString('base64'),
    }),
  });

  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].msg.media.kind, 'audio');
  assert.equal(ingested[0].msg.media.mimeType, 'audio/ogg');
});

test('Enterprise WhatsApp manager ignores messages older than the current startup window', async () => {
  const ingested = [];
  const manager = new EnterpriseWhatsAppConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ingestService: {
      ingestWhatsappMessage: async (payload) => {
        ingested.push(payload);
        return { accepted: true };
      },
    },
  });

  manager._running = true;
  manager.acceptMessagesAfterMs = Date.now();

  await manager.handleIncomingMessage({
    id: { id: 'old-web-1' },
    from: '966501234567@c.us',
    body: 'old customer message',
    timestamp: Math.floor((Date.now() - 60 * 60 * 1000) / 1000),
  });

  assert.deepEqual(ingested, []);
});
