'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { quotedStanzaIdFromBaileysMessage } = require('../src/services/whatsapp/baileys-connection-manager');

const silentLogger = { info: () => {}, warn: () => {} };

function fakeDb() {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'conv-1', phone_number: null }] };
        if (/RETURNING id/.test(sql)) return { rows: [{ id: 'msg-1' }] };
        return { rows: [] };
      },
    }),
  };
}

function fakeBridge({ thread = null, activeThread = null, statusQuery = false } = {}) {
  const ops = [];
  return {
    ops,
    findThreadByQuotedId: async () => thread,
    findActiveThreadForCustomer: async () => activeThread,
    isThreadStatusQuery: () => statusQuery,
    buildThreadStatusReply: async () => '📊 وضع المحادثة',
    relayResolutionToCustomer: async (args) => { ops.push({ op: 'relay', args }); return { relayed: true, replyMessageId: 'r1' }; },
    forwardCustomerReplyToTeam: async (args) => { ops.push({ op: 'forward', args }); return { forwarded: true }; },
  };
}

test('a group quote-reply matching a thread is relayed to the customer (no AI, no group drop)', async () => {
  const thread = { id: '9', customer_sender: '9665001@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'conv-9' };
  const bridge = fakeBridge({ thread });
  let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge,
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
  });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: {
      id: { id: 'TEAMMSG1' }, from: '120363@g.us', author: '966599@s.whatsapp.net',
      fromMe: false, body: 'تم حل المشكلة، الطلب يوصلك بكرة', quotedStanzaId: 'ESCMSG1',
    },
    source: 'baileys',
  });

  assert.equal(result.bridged, true);
  assert.equal(result.customerSender, '9665001@s.whatsapp.net');
  assert.equal(aiEnqueued, 0, 'team reply must never trigger the AI');
  assert.equal(bridge.ops[0].op, 'relay');
  assert.equal(bridge.ops[0].args.text, 'تم حل المشكلة، الطلب يوصلك بكرة');
});

test('owner quote-reply (fromMe) inside the group bridges too, before fromMe routing', async () => {
  const thread = { id: '9', customer_sender: '9665001@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'conv-9' };
  const bridge = fakeBridge({ thread });
  const service = new MessageIngestService({ database: fakeDb(), logger: silentLogger, bridge, queue: { enqueueAiReply: async () => {} } });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'X' }, from: '120363@g.us', fromMe: true, body: 'أبشر يا طويل العمر تم الشحن', quotedStanzaId: 'ESCMSG1' },
    source: 'baileys',
  });
  assert.equal(result.bridged, true);
});

test('group chatter without a matching quote stays ignored exactly as before', async () => {
  const bridge = fakeBridge({ thread: null });
  const service = new MessageIngestService({ database: fakeDb(), logger: silentLogger, bridge, queue: { enqueueAiReply: async () => {} } });

  const noQuote = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'A' }, from: '120363@g.us', fromMe: false, body: 'صباح الخير يا شباب' },
    source: 'baileys',
  });
  assert.equal(noQuote.accepted, false);
  assert.equal(noQuote.reason, 'ignored');

  const unknownQuote = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'B' }, from: '120363@g.us', fromMe: false, body: 'رد على رسالة عادية', quotedStanzaId: 'NOT-A-THREAD' },
    source: 'baileys',
  });
  assert.equal(unknownQuote.accepted, false);
  assert.equal(unknownQuote.reason, 'ignored');
});

test('quoted team reply with media only is skipped with a clear reason', async () => {
  const thread = { id: '9', customer_sender: '9665001@s.whatsapp.net', target_jid: '120363@g.us' };
  const bridge = fakeBridge({ thread });
  const service = new MessageIngestService({ database: fakeDb(), logger: silentLogger, bridge, queue: { enqueueAiReply: async () => {} } });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'C' }, from: '120363@g.us', fromMe: false, body: '', hasMedia: true, media: { kind: 'image' }, quotedStanzaId: 'ESCMSG1' },
    source: 'baileys',
  });
  assert.equal(result.reason, 'bridge_empty_text');
});

test('customer messages are NEVER auto-forwarded to the team — even with an open thread', async () => {
  // Owner's hard rule (2026-06-12, after the shuttle incident): the group
  // hears about a customer ONLY via escalations/updates. Normal conversation
  // stays between the customer and the AI.
  const activeThread = { id: '9', customer_sender: '9665001@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'conv-9' };
  const bridge = fakeBridge({ activeThread });
  let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge,
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
  });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'CUST1' }, from: '9665001@s.whatsapp.net', fromMe: false, body: 'السلام عليكم' },
    source: 'baileys',
  });
  assert.equal(result.accepted, true);
  assert.equal(aiEnqueued, 1, 'the AI handles the conversation normally');
  await new Promise(r => setImmediate(r));
  const fwd = bridge.ops.find(o => o.op === 'forward');
  assert.equal(fwd, undefined, 'NO forwarding of customer messages, ever');
});

test('customer message without an active thread does not touch the bridge forward', async () => {
  const bridge = fakeBridge({ activeThread: null });
  const service = new MessageIngestService({ database: fakeDb(), logger: silentLogger, bridge, queue: { enqueueAiReply: async () => {} } });
  await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'D' }, from: '9665002@s.whatsapp.net', fromMe: false, body: 'كم سعر الاشتراك؟' },
    source: 'baileys',
  });
  await new Promise(r => setImmediate(r));
  assert.equal(bridge.ops.length, 0);
});

// ── quoted id extraction from raw Baileys shapes

test('quotedStanzaIdFromBaileysMessage finds contextInfo on text and media parts', () => {
  assert.equal(
    quotedStanzaIdFromBaileysMessage({ extendedTextMessage: { text: 'حل', contextInfo: { stanzaId: 'Q1' } } }),
    'Q1',
  );
  assert.equal(
    quotedStanzaIdFromBaileysMessage({ imageMessage: { caption: 'صورة', contextInfo: { stanzaId: 'Q2' } } }),
    'Q2',
  );
  assert.equal(quotedStanzaIdFromBaileysMessage({ conversation: 'بدون اقتباس' }), null);
  assert.equal(quotedStanzaIdFromBaileysMessage({}), null);
});

// ── outgoing worker records team-bound escalation sends

test('outgoing worker records an escalation thread row after a successful send', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  const sendIdx = src.indexOf('await sendWhatsappReply');
  const recordIdx = src.indexOf('recordThreadMessage', sendIdx);
  assert.ok(recordIdx > sendIdx, 'thread recording must happen after the send succeeds');
  assert.match(src, /payload\.escalation && payload\.customerSender && sendResult\?\.key\?\.id/);
});
