'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BaileysConnectionManager,
  createBaileysClientWrapper,
} = require('../src/services/whatsapp/baileys-connection-manager');
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

test('Baileys send reserves its generated id durably before calling WhatsApp', async () => {
  const events = [];
  const client = createBaileysClientWrapper({
    sock: {
      user: { id: '966500000000:1@s.whatsapp.net' },
      sendMessage: async (_target, _content, options) => {
        events.push({ type: 'send', messageId: options?.messageId });
        return { key: { id: options?.messageId } };
      },
      sendPresenceUpdate: async () => {},
    },
    isReady: () => true,
    isReadOnly: () => false,
    status: () => 'connected',
    reserveBotSend: async ({ messageId }) => events.push({ type: 'reserve', messageId }),
    confirmBotSend: async ({ messageId }) => events.push({ type: 'confirm', messageId }),
  });

  const result = await client.sendMessage('966500000001', 'اختبار');

  assert.deepEqual(events.map(event => event.type), ['reserve', 'send', 'confirm']);
  assert.ok(events[0].messageId);
  assert.equal(events[0].messageId, events[1].messageId);
  assert.equal(result.key.id, events[0].messageId);
});

test('Baileys does not send when durable bot-id reservation fails', async () => {
  let sent = false;
  const client = createBaileysClientWrapper({
    sock: {
      user: { id: '966500000000:1@s.whatsapp.net' },
      sendMessage: async () => { sent = true; },
      sendPresenceUpdate: async () => {},
    },
    isReady: () => true,
    isReadOnly: () => false,
    status: () => 'connected',
    reserveBotSend: async () => { throw new Error('database unavailable'); },
  });

  await assert.rejects(() => client.sendMessage('966500000001', 'اختبار'), /database unavailable/);
  assert.equal(sent, false);
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

test('ingestOutboundHumanMessage: a reserved bot id is recognized before the message row is updated', async () => {
  let ownershipChecks = 0;
  const db = {
    isConfigured: () => true,
    query: async (text) => {
      if (/whatsapp_bot_send_ids/.test(text)) {
        ownershipChecks += 1;
        return { rows: [{ x: 1 }] };
      }
      return { rows: [] };
    },
    transaction: async () => { throw new Error('transaction must NOT run for a reserved bot echo'); },
  };
  const svc = new MessageIngestService({ logger: silent, database: db });
  const msg = { id: { _serialized: 'BOT-RACE', id: 'BOT-RACE' }, from: '966500000@s.whatsapp.net', fromMe: true, body: 'رد البوت' };

  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });

  assert.equal(res.reason, 'own_bot_echo');
  assert.equal(ownershipChecks, 1);
});

test('ingestOutboundHumanMessage: an ownership lookup error fails closed and cannot pause or resolve escalation', async () => {
  const db = {
    isConfigured: () => true,
    query: async (text) => {
      if (/whatsapp_message_id/.test(text)) throw new Error('temporary database error');
      return { rows: [] };
    },
    transaction: async () => { throw new Error('transaction must NOT run while ownership is unknown'); },
  };
  const svc = new MessageIngestService({ logger: silent, database: db, ownerEchoSettleMs: 0 });
  const msg = { id: { _serialized: 'UNKNOWN1', id: 'UNKNOWN1' }, from: '966500000@s.whatsapp.net', fromMe: true, body: 'رد غير مؤكد' };

  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });

  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'from_me_ownership_unverified');
});

test('Baileys retries an unverified fromMe event instead of dropping the owner reply', async () => {
  let attempts = 0;
  const mgr = makeManager();
  mgr.ingestRetryDelayMs = () => 0;
  mgr.ingestService = {
    ingestWhatsappMessage: async () => {
      attempts += 1;
      return attempts === 1
        ? { accepted: false, reason: 'from_me_ownership_unverified' }
        : { accepted: true, fromMe: true };
    },
  };

  const result = await mgr.processInboundBaileysMessage({}, {
    id: { id: 'OWNER-RETRY' },
    from: '966500000@s.whatsapp.net',
    fromMe: true,
    body: 'رد المالك',
  });

  assert.equal(attempts, 2);
  assert.equal(result.accepted, true);
});

test('ingestOutboundHumanMessage: a genuine owner reply DOES pause the bot (escalated_until)', async () => {
  const updates = [];
  const db = {
    isConfigured: () => true,
    query: async (text, params) => {
      if (/whatsapp_message_id/.test(text)) return { rows: [] };                  // NOT our own send
      if (/UPDATE conversations[\s\S]*SET escalated_until/.test(text)) { updates.push(params); return { rowCount: 1 }; }
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (text) => {
        if (/INSERT INTO conversations/.test(text)) return { rows: [{ id: 'conv1', phone_number: null }] };
        if (/INSERT INTO messages/.test(text)) return { rows: [{ id: 'msg1', created_at: '2026-07-24T10:00:00.000Z' }] };
        return { rows: [] };
      },
    }),
  };
  const svc = new MessageIngestService({ logger: silent, database: db, ownerEchoSettleMs: 0 });
  svc.resolveOwnerPauseMinutes = async () => 30; // avoid the config lookup
  const msg = { id: { _serialized: 'OWNER9', id: 'OWNER9' }, from: '966500000@s.whatsapp.net', fromMe: true, body: 'انا المالك رديت على العميل' };
  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });
  assert.equal(res.fromMe, true);
  assert.equal(res.reason, undefined);
  assert.equal(updates.length, 1, 'owner reply must set escalated_until exactly once');
});

test('ingestOutboundHumanMessage: a genuine owner reply closes pending escalation state', async () => {
  const transactionQueries = [];
  const db = {
    isConfigured: () => true,
    query: async (text) => {
      if (/whatsapp_message_id/.test(text)) return { rows: [] };
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (text, params) => {
        transactionQueries.push({ text, params });
        if (/INSERT INTO conversations/.test(text)) return { rows: [{ id: 'conv1', phone_number: null }] };
        if (/INSERT INTO messages/.test(text)) return { rows: [{ id: 'msg1', created_at: '2026-07-24T10:00:00.000Z' }] };
        return { rows: [], rowCount: 0 };
      },
    }),
  };
  const svc = new MessageIngestService({ logger: silent, database: db, ownerEchoSettleMs: 0 });
  svc.resolveOwnerPauseMinutes = async () => 0;
  const msg = {
    id: { _serialized: 'OWNER10', id: 'OWNER10' },
    from: '966500000@s.whatsapp.net',
    fromMe: true,
    body: 'تم حل المشكلة',
  };

  await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });

  const close = transactionQueries.find(call => /UPDATE escalation_threads[\s\S]*SET resolved_at = NOW\(\)/.test(call.text));
  assert.ok(close, 'a direct owner reply must close unresolved escalation state');
  assert.match(close.text, /user_id = \$1/);
  assert.match(close.text, /conversation_id = \$2/);
  assert.match(close.text, /resolved_at IS NULL/);
  assert.match(close.text, /created_at <= \$3/);
  assert.deepEqual(close.params, ['u1', 'conv1', '2026-07-24T10:00:00.000Z']);
});

test('a live owner reply uses precise receive time instead of the provider second timestamp', async () => {
  const transactionQueries = [];
  const db = {
    isConfigured: () => true,
    query: async (text) => (/whatsapp_message_id/.test(text) ? { rows: [] } : { rows: [] }),
    transaction: async (fn) => fn({
      query: async (text, params) => {
        transactionQueries.push({ text, params });
        if (/INSERT INTO conversations/.test(text)) return { rows: [{ id: 'conv1', phone_number: null }] };
        if (/INSERT INTO messages/.test(text)) {
          return { rows: [{ id: 'msg-live', created_at: params[6] }] };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  };
  const svc = new MessageIngestService({ logger: silent, database: db, ownerEchoSettleMs: 0 });
  svc.resolveOwnerPauseMinutes = async () => 0;
  const receivedAt = Date.parse('2026-07-24T10:00:00.900Z');

  await svc.ingestOutboundHumanMessage({
    userId: 'u1',
    msg: {
      id: { id: 'OWNER-PRECISE' },
      from: '966500000@s.whatsapp.net',
      fromMe: true,
      body: 'تم',
      timestamp: Date.parse('2026-07-24T10:00:00.000Z') / 1000,
      receivedAt,
      syncBatch: false,
    },
  });

  const insert = transactionQueries.find(call => /INSERT INTO messages/.test(call.text));
  assert.equal(new Date(insert.params[6]).toISOString(), '2026-07-24T10:00:00.900Z');
});

test('ingestOutboundHumanMessage: replaying an old owner message cannot close a newer escalation or re-pause the bot', async () => {
  const transactionQueries = [];
  const pauseUpdates = [];
  const db = {
    isConfigured: () => true,
    query: async (text, params) => {
      if (/whatsapp_message_id/.test(text)) return { rows: [] };
      if (/UPDATE conversations[\s\S]*SET escalated_until/.test(text)) pauseUpdates.push(params);
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (text, params) => {
        transactionQueries.push({ text, params });
        if (/INSERT INTO conversations/.test(text)) return { rows: [{ id: 'conv1', phone_number: null }] };
        if (/INSERT INTO messages/.test(text)) return { rows: [] }; // duplicate provider id
        if (/SELECT id, created_at FROM messages/.test(text)) {
          return { rows: [{ id: 'old-msg', created_at: '2026-07-23T10:00:00.000Z' }] };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  };
  const svc = new MessageIngestService({ logger: silent, database: db, ownerEchoSettleMs: 0 });
  svc.resolveOwnerPauseMinutes = async () => 30;
  const msg = {
    id: { _serialized: 'OLD-OWNER-REPLAY', id: 'OLD-OWNER-REPLAY' },
    from: '966500000@s.whatsapp.net',
    fromMe: true,
    body: 'رسالة مالك قديمة أعيدت',
  };

  const res = await svc.ingestOutboundHumanMessage({ userId: 'u1', msg });

  assert.equal(res.reason, 'duplicate_owner_message');
  assert.equal(transactionQueries.some(call => /UPDATE escalation_threads/.test(call.text)), false);
  assert.equal(pauseUpdates.length, 0);
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
