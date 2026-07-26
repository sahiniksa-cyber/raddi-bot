'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { canonicalConfig } = require('./helpers/canonical-config');

test('FULL: price-looking edit cannot update products without a typed canonical policy', async () => {
  const group = '120363000@g.us';
  const config = canonicalConfig({
    contacts: [{ id: 'team', name: 'الفريق', phoneNumber: '+120363000' }],
  });
  const writes = [];
  const database = {
    isConfigured: () => true,
    async query(sql, params = []) {
      writes.push({ sql, params });
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM prompt_edit_requests/.test(sql)) return { rows: [] };
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      return { rows: [] };
    },
  };
  const service = new MessageIngestService({
    database,
    logger: { info() {}, warn() {} },
    queue: { enqueueAiReply: async () => { throw new Error('must not enqueue customer AI'); } },
    enqueueOutgoing: async () => {},
  });
  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'P1' }, from: group, fromMe: false, body: 'غيّر سعر أدوبي إلى 99' },
    source: 'baileys',
  });
  assert.equal(result.promptEdit, 'needs_review');
  assert.ok(!writes.some(write => /UPDATE bot_configs/.test(write.sql)));
});
