'use strict';

// End-to-end wiring: the REAL prompt-edit service through the REAL
// MessageIngestService (nothing about prompt-edit is mocked). Only leaf I/O is
// faked — a stateful in-memory DB modelling the session row + dedup table, the
// AI client factory, and the outgoing enqueue. Proves the full menu chain:
//   trigger → menu → pick section → input → proposal → نعم → bot_configs updated.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363999@g.us';

// Stateful DB modelling the columns the state machine reads/writes.
function statefulDb(initialConfig) {
  let config = { ...initialConfig };
  const rows = new Map();
  const claimed = new Set();
  let seq = 0;
  return {
    get config() { return config; },
    get rows() { return rows; },
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/INSERT INTO whatsapp_group_action_dedup/.test(sql)) {
        const key = `${params[0]}::${params[1]}`;
        if (claimed.has(key)) return { rows: [] };
        claimed.add(key);
        return { rows: [{ message_id: params[1] }] };
      }
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [] };
      if (/SELECT[\s\S]*FROM prompt_edit_requests[\s\S]*status = 'pending'[\s\S]*ORDER BY created_at DESC/.test(sql)) {
        const active = [...rows.values()].filter((r) => r.status === 'pending')
          .sort((a, b) => b.created_at - a.created_at)[0];
        return { rows: active ? [{ ...active }] : [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        const id = `pe-${++seq}`;
        rows.set(id, {
          id, user_id: params[0], source_jid: params[1], requester_jid: params[2],
          request_text: params[3], current_instructions: params[4],
          proposed_instructions: params[5], change_summary: params[6],
          status: 'pending', target: params[7],
          proposed_value: params[8] == null ? null : JSON.parse(params[8]),
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

function buildService(db, sent, extra = {}) {
  let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: db,
    logger: silentLogger,
    bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'prompt' }),
      proposePromptEdit: async (current, request) => ({
        newInstructions: `${current}\n${request}`.trim(),
        summary: `تعديل التعليمات: ${request}`,
      }),
      classifyReplyIntent: async () => 'other',
      ...extra.ai,
    }),
  });
  return { service, aiEnqueued: () => aiEnqueued };
}

const ingest = (service, id, body) => service.ingestWhatsappMessage({
  userId: 'u1',
  msg: { id: { id }, from: GROUP, author: '96650@s.whatsapp.net', fromMe: false, body },
  source: 'baileys',
});

test('FULL MENU FLOW: trigger → menu → prompt section → input → نعم → botInstructions updated', async () => {
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    botInstructions: 'أنت موظف خدمة عملاء لمتجر ProStoree. ساعات العمل ٩ص-٩م.',
    whatsappPromptEditEnabled: true,
  });
  const sent = [];
  const { service, aiEnqueued } = buildService(db, sent);

  const r1 = await ingest(service, 'M1', 'تعديل');
  assert.equal(r1.promptEdit, 'menu');
  assert.match(sent[0].reply, /وش تبي تعدّل/);

  const r2 = await ingest(service, 'M2', '1'); // تعليمات البوت
  assert.equal(r2.promptEdit, 'section');

  const r3 = await ingest(service, 'M3', 'التوصيل مجاني داخل الرياض، وبقية المدن ٢٥ ريال');
  assert.equal(r3.promptEdit, 'proposed');
  assert.match(sent[sent.length - 1].reply, /أأكّد/);

  const r4 = await ingest(service, 'M4', 'نعم');
  assert.equal(r4.promptEdit, 'applied');

  assert.match(db.config.botInstructions, /التوصيل مجاني داخل الرياض/, 'botInstructions really updated');
  assert.match(db.config.botInstructions, /ساعات العمل/, 'original instructions preserved');
  assert.equal(aiEnqueued(), 0, 'never reached the customer AI');
});

test('FULL FLOW: re-delivering ANY step message does not double-advance (idempotent)', async () => {
  const db = statefulDb({
    escalationContacts: [{ name: 'الفريق', phone: GROUP }],
    botInstructions: 'تعليمات حالية كافية الطول.',
    whatsappPromptEditEnabled: true,
  });
  const sent = [];
  const { service } = buildService(db, sent);

  // Trigger delivered 3× (reconnect re-sync) → one menu only.
  assert.equal((await ingest(service, 'T', 'تعديل')).promptEdit, 'menu');
  assert.equal((await ingest(service, 'T', 'تعديل')).promptEdit, 'duplicate');
  assert.equal((await ingest(service, 'T', 'تعديل')).promptEdit, 'duplicate');
  const active = [...db.rows.values()].filter((r) => r.status === 'pending');
  assert.equal(active.length, 1, 'exactly one session');

  await ingest(service, 'S1', '1');           // prompt section
  await ingest(service, 'I1', 'أضف معلومة');   // input → proposal

  // نعم delivered 3× → applied exactly once.
  assert.equal((await ingest(service, 'Y', 'نعم')).promptEdit, 'applied');
  assert.notEqual((await ingest(service, 'Y', 'نعم')).promptEdit, 'applied');
  assert.notEqual((await ingest(service, 'Y', 'نعم')).promptEdit, 'applied');
  assert.equal([...db.rows.values()].filter((r) => r.status === 'applied').length, 1, 'applied exactly once');
});

test('FULL FLOW: لا after a proposal leaves bot_configs untouched', async () => {
  const original = 'تعليمات أصلية ثابتة لا يجب أن تتغير عند الرفض.';
  const db = statefulDb({ escalationContacts: [{ name: 'الفريق', phone: GROUP }], botInstructions: original });
  const sent = [];
  const { service } = buildService(db, sent);
  await ingest(service, 'N1', 'تعديل');
  await ingest(service, 'N2', '1');
  await ingest(service, 'N3', 'غيّر اسم الموظف');
  const r = await ingest(service, 'N4', 'لا');
  assert.equal(r.promptEdit, 'rejected');
  assert.equal(db.config.botInstructions, original, 'instructions unchanged after rejection');
});
