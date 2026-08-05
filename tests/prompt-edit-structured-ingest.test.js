'use strict';

// End-to-end wiring for a STRUCTURED edit (products) through the real
// MessageIngestService via the menu flow. Proves the product edit applies to
// the products array and never reaches the customer AI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';

function statefulDb(initialConfig) {
  let config = { ...initialConfig };
  const rows = new Map();
  const claimed = new Set();
  let seq = 0;
  return {
    get config() { return config; },
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/INSERT INTO whatsapp_group_action_dedup/.test(sql)) {
        const key = `${params[0]}::${params[1]}`;
        if (claimed.has(key)) return { rows: [] };
        claimed.add(key);
        return { rows: [{ message_id: params[1] }] };
      }
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/SELECT[\s\S]*FROM prompt_edit_requests[\s\S]*status = 'pending'[\s\S]*ORDER BY created_at DESC/.test(sql)) {
        const active = [...rows.values()].filter((r) => r.status === 'pending').sort((a, b) => b.created_at - a.created_at)[0];
        return { rows: active ? [{ ...active }] : [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        const id = `pe-${++seq}`;
        rows.set(id, {
          id, status: 'pending', target: params[7],
          proposed_value: params[8] == null ? null : JSON.parse(params[8]),
          proposed_instructions: params[5], change_summary: params[6],
          stage: params[9], section: params[10],
          context: params[11] == null ? null : JSON.parse(params[11]),
          created_at: Date.now() + seq,
        });
        return { rows: [{ id }] };
      }
      if (/UPDATE prompt_edit_requests\s+SET stage =/.test(sql)) {
        const row = rows.get(params[0]);
        if (row) {
          row.stage = params[1]; row.section = params[2];
          row.context = params[3] == null ? null : JSON.parse(params[3]);
          row.target = params[4]; row.request_text = params[5];
          row.proposed_instructions = params[6]; row.change_summary = params[7];
          row.proposed_value = params[8] == null ? null : JSON.parse(params[8]);
        }
        return { rows: [] };
      }
      if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) {
        for (const r of rows.values()) if (r.status === 'pending') r.status = 'expired';
        return { rows: [] };
      }
      if (/UPDATE prompt_edit_requests SET status = \$2[\s\S]*status = 'pending' RETURNING id/.test(sql)) {
        const row = rows.get(params[0]);
        if (row && row.status === 'pending') { row.status = params[1]; return { rows: [{ id: row.id }] }; }
        return { rows: [] };
      }
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

test('FULL: menu → products → "غيّر سعر أدوبي إلى 99" → نعم → products updated, never sent to customer', async () => {
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    products: [{ name: 'اشتراك أدوبي', price: '80' }],
    autoReplyKeywords: {}, doNotReplyList: [],
  });
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
  const ingest = (id, body) => service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id }, from: GROUP, fromMe: false, body }, source: 'baileys' });

  assert.equal((await ingest('P1', 'تعديل')).promptEdit, 'menu');
  assert.equal((await ingest('P2', '2')).promptEdit, 'section'); // products
  const r3 = await ingest('P3', 'غيّر سعر أدوبي إلى 99');
  assert.equal(r3.promptEdit, 'proposed');
  assert.match(sent[sent.length - 1].reply, /تحديث سعر أدوبي/);

  const r4 = await ingest('P4', 'نعم');
  assert.equal(r4.promptEdit, 'applied');
  const adobe = db.config.products.find((p) => p.name === 'اشتراك أدوبي');
  assert.equal(adobe.price, '99', 'price really updated in products');
  assert.equal(aiEnqueued, 0, 'never reached the customer AI');
});
