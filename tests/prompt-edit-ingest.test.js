'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';

function fakeDb() {
  return {
    isConfigured: () => true,
    query: async () => ({ rows: [] }),
    transaction: async (fn) => fn({ query: async (sql) => {
      if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'c', phone_number: null }] };
      if (/RETURNING id/.test(sql)) return { rows: [{ id: 'm' }] };
      return { rows: [] };
    } }),
  };
}
function fakeBridge() {
  return {
    findThreadByQuotedId: async () => null,
    findActiveThreadForCustomer: async () => null,
    isThreadStatusQuery: () => false,
    buildThreadStatusReply: async () => '',
    forwardCustomerReplyToTeam: async () => ({ forwarded: true }),
    relayResolutionToCustomer: async () => ({ relayed: true }),
  };
}

test('an edit command in the group is handled by the prompt-edit service and not dropped/sent to AI', async () => {
  let aiEnqueued = 0;
  let handledMsg = null;
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    promptEdit: async ({ msg }) => { handledMsg = msg.body; return { accepted: true, statusCode: 200, promptEdit: 'proposed' }; },
  });

  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'E1' }, from: GROUP, fromMe: false, body: 'تعديل: أضف معلومة' },
    source: 'baileys',
  });

  assert.equal(res.promptEdit, 'proposed');
  assert.equal(aiEnqueued, 0, 'edit command never reaches the customer AI');
  assert.equal(handledMsg, 'تعديل: أضف معلومة');
});

test('a normal group message still falls through to ignore when prompt-edit returns null', async () => {
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    promptEdit: async () => null,
  });
  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G1' }, from: GROUP, fromMe: false, body: 'صباح الخير' },
    source: 'baileys',
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'ignored');
});

test('a prompt-edit handler that throws does not break ingest (fail-open to ignore)', async () => {
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    promptEdit: async () => { throw new Error('boom'); },
  });
  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G2' }, from: GROUP, fromMe: false, body: 'تعديل: شيء' },
    source: 'baileys',
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'ignored');
});
