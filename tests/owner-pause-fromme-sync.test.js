'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { markConversationMessagesMutedSkipped } = require('../src/workers/ai-worker');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

// ===== Layer 1: handleMessages honors owner fromMe in 'append' (device-sync) batches =====

function makeManager() {
  const mgr = new BaileysConnectionManager({
    userId: 'u1',
    dataDir: '/tmp',
    logger: silent,
    ingestService: { ingestWhatsappMessage: async () => ({}) },
    database: { isConfigured: () => true, query: async () => ({ rows: [] }) },
  });
  mgr.log = () => {};
  mgr._running = true;
  mgr._hasEverConnected = true; // skip startup-bulk-batch heuristic
  return mgr;
}

const nowSec = Math.floor(Date.now() / 1000);
function rawMsg({ id, fromMe, body = 'hi' }) {
  return {
    key: { id, remoteJid: '966500000@s.whatsapp.net', fromMe },
    message: { conversation: body },
    messageTimestamp: nowSec,
  };
}

test('append batch: ONLY the owner (fromMe) message is processed — customer backlog ignored', () => {
  const mgr = makeManager();
  const processed = [];
  mgr.processInboundBaileysMessage = (raw, msg) => { processed.push(msg); return Promise.resolve(); };
  mgr.handleMessages({
    type: 'append',
    messages: [
      rawMsg({ id: 'OWNER1', fromMe: true, body: 'رد المالك من جواله' }),
      rawMsg({ id: 'CUST1', fromMe: false, body: 'رسالة عميل قديمة مُزامَنة' }),
    ],
  });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].fromMe, true);
  assert.equal(processed[0].id.id, 'OWNER1');
});

test('notify batch: a normal customer message is still processed', () => {
  const mgr = makeManager();
  const processed = [];
  mgr.processInboundBaileysMessage = (raw, msg) => { processed.push(msg); return Promise.resolve(); };
  mgr.handleMessages({ type: 'notify', messages: [rawMsg({ id: 'CUST2', fromMe: false, body: 'سؤال' })] });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].fromMe, false);
});

test('append batch with ONLY customer messages: nothing processed (no backlog replay)', () => {
  const mgr = makeManager();
  const processed = [];
  mgr.processInboundBaileysMessage = (raw, msg) => { processed.push(msg); return Promise.resolve(); };
  mgr.handleMessages({ type: 'append', messages: [rawMsg({ id: 'C1', fromMe: false }), rawMsg({ id: 'C2', fromMe: false })] });
  assert.equal(processed.length, 0);
});

// ===== Layer 2: the bot's OWN echoed send must not be mistaken for an owner reply =====

test('isOwnBotSend distinguishes a recorded bot send from an owner reply', async () => {
  const own = new MessageIngestService({ logger: silent, database: { isConfigured: () => true, query: async () => ({ rows: [{ x: 1 }] }) } });
  assert.equal(await own.isOwnBotSend({ userId: 'u1', whatsappId: 'X' }), true);
  const notOwn = new MessageIngestService({ logger: silent, database: { isConfigured: () => true, query: async () => ({ rows: [] }) } });
  assert.equal(await notOwn.isOwnBotSend({ userId: 'u1', whatsappId: 'X' }), false);
});

test('ingestOutboundHumanMessage: the BOT echo does NOT pause (own_bot_echo, no transaction)', async () => {
  const queries = [];
  const db = {
    isConfigured: () => true,
    query: async (text) => {
      queries.push(text);
      if (/whatsapp_message_id/.test(text)) return { rows: [{ x: 1 }] }; // it's our own send
      return { rows: [] };
    },
    transaction: async () => { throw new Error('transaction must NOT run for the bot echo'); },
  };
  const svc = new MessageIngestService({ logger: silent, database: db });
  const msg = { id: { _serialized: 'BOT1', id: 'BOT1' }, from: '966500000@s.whatsapp.net', fromMe: true, body: 'رد البوت' };
  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });
  assert.equal(res.reason, 'own_bot_echo');
  assert.ok(!queries.some(q => /UPDATE conversations SET escalated_until/.test(q)), 'bot echo must NOT set owner-pause');
});

test('ingestOutboundHumanMessage: a genuine owner reply DOES pause the bot (escalated_until)', async () => {
  const updates = [];
  const db = {
    isConfigured: () => true,
    query: async (text, params) => {
      if (/whatsapp_message_id/.test(text)) return { rows: [] };                  // NOT our own send
      if (/UPDATE conversations SET escalated_until/.test(text)) { updates.push(params); return { rowCount: 1 }; }
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (text) => {
        if (/INSERT INTO conversations/.test(text)) return { rows: [{ id: 'conv1', phone_number: null }] };
        if (/INSERT INTO messages/.test(text)) return { rows: [{ id: 'msg1' }] };
        return { rows: [] };
      },
    }),
  };
  const svc = new MessageIngestService({ logger: silent, database: db });
  svc.resolveOwnerPauseMinutes = async () => 30; // avoid the config lookup
  const msg = { id: { _serialized: 'OWNER9', id: 'OWNER9' }, from: '966500000@s.whatsapp.net', fromMe: true, body: 'انا المالك رديت على العميل' };
  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });
  assert.equal(res.fromMe, true);
  assert.equal(res.reason, undefined);
  assert.equal(updates.length, 1, 'owner reply must set escalated_until exactly once');
});

// ===== Messages received DURING the mute are retired, not answered after it lifts =====

test('markConversationMessagesMutedSkipped retires ONLY queued_for_ai inbound for the conversation', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    query: async (text, params) => { calls.push({ text, params }); return { rowCount: 2 }; },
  };
  const res = await markConversationMessagesMutedSkipped({ database, userId: 'u1', conversationId: 'c1' });
  assert.equal(res.retired, 2);
  const q = calls[0];
  assert.match(q.text, /status = 'skipped_escalation_muted'/);
  assert.match(q.text, /direction = 'inbound'/);
  assert.match(q.text, /status = 'queued_for_ai'/);
  assert.equal(q.params[0], 'u1');
  assert.equal(q.params[1], 'c1');
});

test('markConversationMessagesMutedSkipped no-ops without a conversationId', async () => {
  const database = { isConfigured: () => true, query: async () => { throw new Error('should not query'); } };
  const res = await markConversationMessagesMutedSkipped({ database, userId: 'u1', conversationId: null });
  assert.equal(res.retired, 0);
});
