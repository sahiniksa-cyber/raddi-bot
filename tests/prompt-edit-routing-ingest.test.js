'use strict';

// End-to-end: an operational (escalation) edit through the real prompt-edit
// service + MessageIngestService. With INSTRUCTION_ROUTING_ENABLED it lands in a
// STRUCTURED field (escalationRules) via the two-step confirm — never in
// botInstructions and never to the customer AI. An unresolvable target is bounced
// back for setup. Flag OFF = legacy prompt behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';

function baseConfig() {
  return {
    escalationContacts: [
      { name: 'الفريق', phone: GROUP },
      { id: 'c1', name: 'سعود', phone: '966500000000' },
    ],
    products: [], autoReplyKeywords: {}, doNotReplyList: [], botInstructions: 'رحّب بالعميل',
  };
}

function statefulDb(initial) {
  let config = { ...initial };
  const edits = [];
  const claimed = new Set();
  let seq = 0;
  return {
    get config() { return config; },
    get edits() { return edits; },
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
function makeService(db, sent, counters) {
  return new MessageIngestService({
    database: db, logger: silentLogger, bridge,
    queue: { enqueueAiReply: async () => { counters.ai++; } },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => null,
      proposePromptEdit: async () => ({ newInstructions: 'رحّب بالعميل\nحوّل لسعود', summary: 'تحديث البرومنت' }),
      classifyReplyIntent: async () => 'other',
    }),
  });
}

test('flag ON: resolvable escalation edit → structured escalationRules, confirmed, never to customer AI', async () => {
  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  const db = statefulDb(baseConfig());
  const sent = []; const counters = { ai: 0 };
  const service = makeService(db, sent, counters);

  const r1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'R1' }, from: GROUP, fromMe: false, body: 'برومنت لو سأل عن الاسترجاع حوّله لسعود' }, source: 'baileys' });
  assert.equal(r1.promptEdit, 'proposed');
  assert.match(sent[0].reply, /سعود/);
  // The pending edit targets the STRUCTURED escalationRules field (not botInstructions).
  const pending = db.edits[db.edits.length - 1];
  assert.equal(pending.target, 'routed:escalationRules');
  assert.equal(pending.proposed_value[0].target_contact_id, 'c1');
  assert.equal(pending.proposed_value[0].trigger_value, 'الاسترجاع');
  assert.equal(counters.ai, 0, 'never reached the customer AI');
  process.env.INSTRUCTION_ROUTING_ENABLED = prev;
});

test('flag ON: unresolvable escalation target → clarification, nothing stored', async () => {
  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  const db = statefulDb(baseConfig());
  const sent = []; const counters = { ai: 0 };
  const service = makeService(db, sent, counters);

  const r = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'R3' }, from: GROUP, fromMe: false, body: 'برومنت حوّل الفواتير لمحمد' }, source: 'baileys' });
  assert.equal(r.promptEdit, 'clarify');
  assert.match(sent[0].reply, /محمد/);
  assert.equal(db.config.escalationRules, undefined, 'nothing stored on an unresolvable target');
  assert.equal(db.config.botInstructions, 'رحّب بالعميل', 'botInstructions untouched');
  process.env.INSTRUCTION_ROUTING_ENABLED = prev;
});

test('flag OFF: same escalation edit falls back to the legacy prompt path (target=prompt)', async () => {
  const prev = process.env.INSTRUCTION_ROUTING_ENABLED;
  process.env.INSTRUCTION_ROUTING_ENABLED = 'false';
  const db = statefulDb(baseConfig());
  const sent = []; const counters = { ai: 0 };
  const service = makeService(db, sent, counters);

  const r1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'R4' }, from: GROUP, fromMe: false, body: 'برومنت لو سأل عن الاسترجاع حوّله لسعود' }, source: 'baileys' });
  assert.equal(r1.promptEdit, 'proposed');
  // Legacy: the edit targets the free-text prompt (botInstructions) — the old leak.
  const pending = db.edits[db.edits.length - 1];
  assert.equal(pending.target, 'prompt');
  assert.match(pending.proposed_instructions, /حوّل لسعود/);
  process.env.INSTRUCTION_ROUTING_ENABLED = prev;
});
