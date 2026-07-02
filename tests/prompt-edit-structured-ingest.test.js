'use strict';

// End-to-end wiring: real prompt-edit service through the real MessageIngestService.
// Only leaf I/O is faked. Proves a structured product edit applies to the products
// array and never reaches the customer AI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';
const CONFIG = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  products: [{ name: 'اشتراك أدوبي', price: '80' }],
  autoReplyKeywords: {}, doNotReplyList: [],
};

function statefulDb() {
  let config = { ...CONFIG };
  const edits = [];
  let seq = 0;
  return {
    get config() { return config; },
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        return { rows: edits.filter((e) => e.status === 'pending').slice(-1) };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        edits.push({
          id: `pe-${++seq}`, status: 'pending', target: params[7],
          proposed_value: params[8] ? JSON.parse(params[8]) : null,
          proposed_instructions: params[5], change_summary: params[6],
          created_at: new Date(Date.now() + seq).toISOString(),
        });
        return { rows: [{ id: `pe-${seq}` }] };
      }
      if (/UPDATE prompt_edit_requests SET status = \$2/.test(sql)) {
        const row = edits.find((e) => e.id === params[0]); if (row) row.status = params[1];
        return { rows: [{ id: params[0] }] };
      }
      if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) return { rows: [] };
      if (/UPDATE bot_configs/.test(sql)) {
        const field = String(params[1]).replace(/[{}]/g, '');
        config = { ...config, [field]: JSON.parse(params[2]) };
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}
const bridge = {
  findThreadByQuotedId: async () => null, findActiveThreadForCustomer: async () => null,
  isThreadStatusQuery: () => false, buildThreadStatusReply: async () => '',
  forwardCustomerReplyToTeam: async () => ({ forwarded: true }), relayResolutionToCustomer: async () => ({ relayed: true }),
};

test('FULL: "غيّر سعر أدوبي إلى 99" -> confirm -> products actually updated, never sent to customer', async () => {
  const db = statefulDb();
  const sent = []; let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: db, logger: silentLogger, bridge,
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99' }),
      proposePromptEdit: async () => ({ newInstructions: 'x', summary: 'y' }),
      classifyReplyIntent: async () => 'other',
    }),
  });

  const r1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'P1' }, from: GROUP, fromMe: false, body: 'غيّر سعر أدوبي إلى 99' }, source: 'baileys' });
  assert.equal(r1.promptEdit, 'proposed');
  assert.equal(aiEnqueued, 0);
  assert.match(sent[0].reply, /تحديث سعر أدوبي/);

  const r2 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'P2' }, from: GROUP, fromMe: false, body: 'نعم' }, source: 'baileys' });
  assert.equal(r2.promptEdit, 'applied');
  const adobe = db.config.products.find((p) => p.name === 'اشتراك أدوبي');
  assert.equal(adobe.price, '99', 'price really updated in products');
  assert.equal(aiEnqueued, 0, 'never reached the customer AI across the whole flow');
});
