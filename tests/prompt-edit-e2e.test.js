'use strict';

// End-to-end wiring test: uses the REAL prompt-edit service wired through the
// REAL MessageIngestService (nothing about prompt-edit is mocked). Only the
// leaf I/O is faked — a stateful in-memory DB, the AI client factory, and the
// outgoing enqueue — so we prove the full chain works together:
//   edit command in group -> proposal stored -> "نعم" -> bot_configs updated.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363999@g.us';

// A small stateful fake DB: holds one bot_configs row + a prompt_edit_requests
// table, and answers the exact queries the service issues.
function statefulDb(initialConfig) {
  let config = { ...initialConfig };
  const edits = [];
  const claimed = new Set(); // models whatsapp_group_action_dedup (ON CONFLICT DO NOTHING)
  let seq = 0;
  return {
    get config() { return config; },
    get edits() { return edits; },
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/INSERT INTO whatsapp_group_action_dedup/.test(sql)) {
        const key = `${params[0]}::${params[1]}`;
        if (claimed.has(key)) return { rows: [] };       // conflict → no row
        claimed.add(key);
        return { rows: [{ message_id: params[1] }] };     // first delivery
      }
      if (/SELECT config FROM bot_configs/.test(sql)) {
        return { rows: [{ config }] };
      }
      if (/FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        const [userId, sourceJid] = params;
        const pend = edits
          .filter(e => e.user_id === userId && e.source_jid === sourceJid && e.status === 'pending')
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return { rows: pend.slice(0, 1) };
      }
      if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) {
        const [userId, sourceJid] = params;
        edits.forEach(e => { if (e.user_id === userId && e.source_jid === sourceJid && e.status === 'pending') e.status = 'expired'; });
        return { rows: [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        const row = {
          id: `pe-${++seq}`,
          user_id: params[0], source_jid: params[1], requester_jid: params[2],
          request_text: params[3], current_instructions: params[4],
          proposed_instructions: params[5], change_summary: params[6],
          status: 'pending', created_at: new Date(Date.now() + seq).toISOString(),
        };
        edits.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/UPDATE prompt_edit_requests SET status = \$2/.test(sql)) {
        const [id, status] = params;
        const row = edits.find(e => e.id === id);
        if (row) row.status = status;
        return { rows: [{ id }] };
      }
      if (/UPDATE bot_configs/.test(sql)) {
        // applySectionValue: params = [userId, '{field}', jsonValue]
        const field = String(params[1]).replace(/[{}]/g, '');
        config = { ...config, [field]: JSON.parse(params[2]) };
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
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

test('FULL FLOW: edit command -> proposal -> نعم -> bot_configs.botInstructions actually updated', async () => {
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    botInstructions: 'أنت موظف خدمة عملاء لمتجر ProStoree. ساعات العمل من ٩ صباحاً إلى ٩ مساءً.',
    whatsappPromptEditEnabled: true,
  });

  const sent = [];
  let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: db,
    logger: silentLogger,
    bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    enqueueOutgoing: async (p) => { sent.push(p); },
    // Real promptEdit (not injected) — wired by the constructor to the real service.
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'prompt' }),
      proposePromptEdit: async (current, request) => ({
        newInstructions: current + '\nالتوصيل مجاني داخل الرياض، وبقية المدن ٢٥ ريال.',
        summary: 'إضافة سياسة التوصيل: مجاني للرياض و٢٥ ريال لبقية المدن.',
      }),
    }),
  });

  // 1) Merchant sends the edit command in the escalation group.
  const r1 = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'M1' }, from: GROUP, author: '96650@s.whatsapp.net', fromMe: false,
           body: 'تعديل: ضيف إن التوصيل مجاني للرياض و٢٥ ريال لبقية المدن' },
    source: 'baileys',
  });
  assert.equal(r1.promptEdit, 'proposed', 'first message recognized as an edit proposal');
  assert.equal(aiEnqueued, 0, 'edit command must NOT reach the customer AI');
  assert.equal(sent.length, 1, 'a summary/confirm message was sent to the group');
  assert.equal(sent[0].sender, GROUP);
  assert.match(sent[0].reply, /سياسة التوصيل/);
  assert.match(sent[0].reply, /نعم/);
  assert.equal(db.edits.filter(e => e.status === 'pending').length, 1, 'one pending edit stored');

  // 2) Merchant confirms with نعم.
  const r2 = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'M2' }, from: GROUP, author: '96650@s.whatsapp.net', fromMe: false, body: 'نعم' },
    source: 'baileys',
  });
  assert.equal(r2.promptEdit, 'applied', 'نعم applies the pending edit');

  // 3) PROOF: the bot's actual instructions changed in bot_configs.
  assert.match(db.config.botInstructions, /التوصيل مجاني داخل الرياض/, 'botInstructions was really updated');
  assert.match(db.config.botInstructions, /ساعات العمل/, 'the original instructions were preserved');
  assert.equal(db.edits.find(e => e.id === 'pe-1').status, 'applied', 'the pending row is marked applied');
  assert.equal(aiEnqueued, 0, 'still no customer-AI involvement across the whole flow');
});

test('FULL FLOW: WhatsApp re-delivering the same edit + نعم does not loop (idempotent)', async () => {
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    botInstructions: 'تعليمات حالية كافية الطول لتكون برومنت سليم بدون أي مشاكل إطلاقاً.',
    whatsappPromptEditEnabled: true,
  });
  const sent = [];
  const service = new MessageIngestService({
    database: db, logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'prompt' }),
      proposePromptEdit: async (current) => ({ newInstructions: current + '\nإضافة.', summary: 'إضافة معلومة.' }),
    }),
  });
  const editMsg = { id: { id: 'DUP_EDIT' }, from: GROUP, author: '96650@s.whatsapp.net', fromMe: false, body: 'تعديل: ضيف معلومة' };
  const yesMsg = { id: { id: 'DUP_YES' }, from: GROUP, author: '96650@s.whatsapp.net', fromMe: false, body: 'نعم' };

  // Edit delivered 3× (reconnect re-sync), then نعم delivered 3×.
  const e1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: editMsg, source: 'baileys' });
  const e2 = await service.ingestWhatsappMessage({ userId: 'u1', msg: editMsg, source: 'baileys' });
  const e3 = await service.ingestWhatsappMessage({ userId: 'u1', msg: editMsg, source: 'baileys' });
  const y1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: yesMsg, source: 'baileys' });
  const y2 = await service.ingestWhatsappMessage({ userId: 'u1', msg: yesMsg, source: 'baileys' });
  const y3 = await service.ingestWhatsappMessage({ userId: 'u1', msg: yesMsg, source: 'baileys' });

  // The re-delivered edit is a silent duplicate (no NEW pending created).
  assert.equal(e1.promptEdit, 'proposed');
  assert.equal(e2.promptEdit, 'duplicate');
  assert.equal(e3.promptEdit, 'duplicate');
  // نعم applies exactly once; re-deliveries must NOT apply again. (After the
  // apply there is no pending left, so a duplicate نعم safely does nothing.)
  assert.equal(y1.promptEdit, 'applied');
  assert.notEqual(y2.promptEdit, 'applied');
  assert.notEqual(y3.promptEdit, 'applied');

  // The real proof against the production loop: exactly ONE proposal + ONE
  // confirmation sent (not six), one pending ever created, applied once.
  assert.equal(sent.length, 2, 'one propose + one apply message, no repeats');
  assert.equal(db.edits.length, 1, 'only one pending edit ever created');
  assert.equal(db.edits.filter(e => e.status === 'applied').length, 1, 'applied exactly once');
});

test('FULL FLOW: لا after a proposal leaves bot_configs untouched', async () => {
  const original = 'تعليمات أصلية ثابتة لا يجب أن تتغير عند الرفض إطلاقاً مهما حصل أبداً.';
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    botInstructions: original,
  });
  const sent = [];
  const service = new MessageIngestService({
    database: db, logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'prompt' }),
      proposePromptEdit: async () => ({ newInstructions: 'نص مرفوض', summary: 'تغيير لن يُطبّق' }),
    }),
  });

  await service.ingestWhatsappMessage({
    userId: 'u1', msg: { id: { id: 'N1' }, from: GROUP, fromMe: false, body: 'تعديل: غيّر اسم الموظف' }, source: 'baileys',
  });
  const r = await service.ingestWhatsappMessage({
    userId: 'u1', msg: { id: { id: 'N2' }, from: GROUP, fromMe: false, body: 'لا' }, source: 'baileys',
  });
  assert.equal(r.promptEdit, 'rejected');
  assert.equal(db.config.botInstructions, original, 'instructions unchanged after rejection');
});
