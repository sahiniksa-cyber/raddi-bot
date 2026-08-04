'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { findLatestThreadForTarget, buildCustomerUpdateText } = require('../src/services/escalation/escalation-bridge');

// Production 2026-06-12 15:57: a SECOND problem in the same conversation hit
// the 30-min anti-spam cooldown — the group got NOTHING while the bot told
// the customer "رسلت للإدارة". Suppressed escalations must become a light
// "🔁 تحديث" message to the group instead of silence.

test('buildCustomerUpdateText carries the customer id, the new problem, and the quote instruction', () => {
  const text = buildCustomerUpdateText({
    customerSender: '966512345678@s.whatsapp.net',
    text: 'عندي مشكلة مع الاشتراك ما يفتح معي أبداً',
  });
  assert.match(text, /تحديث/);
  assert.match(text, /966512345678/);
  assert.match(text, /مشكلة مع الاشتراك/);
  assert.match(text, /رد على هذه الرسالة/);
});

test('ai-worker sends a group update when the escalation is suppressed by cooldown/min-gap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  assert.match(src, /buildCustomerUpdateText/, 'suppressed escalations must forward an update');
  const coolIdx = src.indexOf('cooldown.rowCount > 0');
  const usageIdx = src.indexOf('buildCustomerUpdateText({ customerSender', coolIdx);
  assert.ok(coolIdx > -1 && usageIdx > coolIdx, 'the update must be sent from the suppression branch');
});

// Production 2026-06-12: the owner wrote "وش صار" in the group WITHOUT
// quoting — ignored as group chatter. In a thread-target group, a status
// question answers the LATEST thread even without a quote.

test('findLatestThreadForTarget queries the most recent thread for the group', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: '7', customer_sender: 'c@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'conv' }] }; },
  };
  const thread = await findLatestThreadForTarget({ database, userId: 'u1', targetJid: '120363@g.us' });
  assert.equal(thread.id, '7');
  assert.match(calls[0].sql, /target_jid = \$2/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC/);
});

test('ingest answers a no-quote status question in a thread-target group', async () => {
  const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
  const ops = [];
  const bridge = {
    findThreadByQuotedId: async () => null,
    findActiveThreadForCustomer: async () => null,
    findLatestThreadForTarget: async () => ({ id: '7', customer_sender: 'c@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'conv' }),
    isThreadStatusQuery: (t) => /^وش صار/.test(t),
    buildThreadStatusReply: async () => '📊 وضع المحادثة',
    forwardCustomerReplyToTeam: async (args) => { ops.push(args); return { forwarded: true }; },
    relayResolutionToCustomer: async () => { throw new Error('must not relay a status question'); },
  };
  const service = new MessageIngestService({
    database: { isConfigured: () => true, query: async (sql, params) => (/whatsapp_group_action_dedup/.test(sql) ? { rows: [{ message_id: params?.[1] }] } : { rows: [] }), transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    logger: { info: () => {}, warn: () => {} },
    bridge,
    queue: { enqueueAiReply: async () => {} },
  });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G1' }, from: '120363@g.us', fromMe: true, body: 'وش صار معاك' }, // no quotedStanzaId
    source: 'baileys',
  });
  assert.equal(result.statusQuery, true, `expected status answer, got ${JSON.stringify(result)}`);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].raw, true);
});

test('plain group chatter without a quote and without a status question stays ignored', async () => {
  const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
  const bridge = {
    findThreadByQuotedId: async () => null,
    findActiveThreadForCustomer: async () => null,
    findLatestThreadForTarget: async () => ({ id: '7', customer_sender: 'c', target_jid: 'g', conversation_id: 'conv' }),
    isThreadStatusQuery: () => false,
    buildThreadStatusReply: async () => 'x',
    forwardCustomerReplyToTeam: async () => { throw new Error('must not forward chatter'); },
    relayResolutionToCustomer: async () => { throw new Error('must not relay chatter'); },
  };
  const service = new MessageIngestService({
    database: { isConfigured: () => true, query: async () => ({ rows: [] }), transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    logger: { info: () => {}, warn: () => {} },
    bridge,
    queue: { enqueueAiReply: async () => {} },
  });
  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G2' }, from: '120363@g.us', fromMe: false, body: 'صباح الخير يا شباب' },
    source: 'baileys',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'ignored');
});
