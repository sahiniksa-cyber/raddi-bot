'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordThreadMessage,
  findThreadByQuotedId,
  findActiveThreadForCustomer,
  relayResolutionToCustomer,
  buildCustomerForwardText,
} = require('../src/services/escalation/escalation-bridge');

function fakeDbCapture(rowsByMatch = []) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const { re, rows } of rowsByMatch) {
        if (re.test(sql)) return { rows };
      }
      return { rows: [] };
    },
  };
}

test('recordThreadMessage inserts with conflict-safe dedup', async () => {
  const database = fakeDbCapture();
  await recordThreadMessage({
    database, userId: 'u1', whatsappMessageId: 'WAMID1',
    targetJid: '120363@g.us', customerSender: '9665@s.whatsapp.net', conversationId: 'c1',
  });
  assert.match(database.calls[0].sql, /INSERT INTO escalation_threads/);
  assert.match(database.calls[0].sql, /ON CONFLICT \(user_id, whatsapp_message_id\) DO NOTHING/);
});

test('recordThreadMessage is a no-op without an id (send failed)', async () => {
  const database = fakeDbCapture();
  await recordThreadMessage({ database, userId: 'u1', whatsappMessageId: null, targetJid: 'g', customerSender: 'c' });
  assert.equal(database.calls.length, 0);
});

test('findThreadByQuotedId returns the mapped customer', async () => {
  const row = { id: '5', customer_sender: '9665@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'c1' };
  const database = fakeDbCapture([{ re: /FROM escalation_threads/, rows: [row] }]);
  const thread = await findThreadByQuotedId({ database, userId: 'u1', quotedId: 'WAMID1' });
  assert.equal(thread.customer_sender, '9665@s.whatsapp.net');
});

test('findActiveThreadForCustomer respects the recency window and skips resolved threads', async () => {
  const database = fakeDbCapture([{ re: /FROM escalation_threads/, rows: [] }]);
  await findActiveThreadForCustomer({ database, userId: 'u1', customerSender: '9665@s.whatsapp.net' });
  assert.match(database.calls[0].sql, /created_at > NOW\(\)/);
  assert.match(database.calls[0].sql, /resolved_at IS NULL/, 'answered threads must stop forwarding customer messages');
  assert.match(database.calls[0].sql, /ORDER BY created_at DESC/);
});

// Owner feedback 2026-06-12: after the team answers ONCE, the bridge must
// HAND BACK to the AI — rephrase the answer in the bot's voice (not verbatim),
// close the thread (no more forwarding every customer message to the group),
// and clear the mute so the AI continues. Anything new it can't answer goes
// through a fresh, normal escalation.

test('relay rephrases the team answer via AI, closes the thread, and hands back to the AI', async () => {
  const database = fakeDbCapture([{ re: /INSERT INTO messages/, rows: [{ id: 'reply-1' }] }]);
  const enqueued = [];
  const thread = { customer_sender: '9665@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'c1' };
  const result = await relayResolutionToCustomer({
    database,
    enqueue: async (payload, opts) => { enqueued.push({ payload, opts }); },
    rephrase: async ({ teamAnswer }) => `حياك الله 🌹 ${teamAnswer} ولو احتجت أي شي أنا موجود`,
    userId: 'u1',
    thread,
    text: 'تم حل المشكلة، الطلب ينوصل بكرة',
    authorJid: '966599@s.whatsapp.net',
  });
  assert.equal(result.relayed, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.sender, '9665@s.whatsapp.net');
  assert.match(enqueued[0].payload.reply, /تم حل المشكلة، الطلب ينوصل بكرة/, 'the team answer content must survive');
  assert.match(enqueued[0].payload.reply, /حياك الله/, 'the answer must be rephrased in the bot voice');
  assert.equal(enqueued[0].opts.delay, 0, 'a fix must go out instantly, no humanization delay');

  const resolve = database.calls.find(c => /SET resolved_at = NOW\(\)/.test(c.sql));
  assert.ok(resolve, 'thread must be closed so customer messages stop forwarding to the group');
  const unmute = database.calls.find(c => /SET escalated_until = NULL/.test(c.sql));
  assert.ok(unmute, 'AI must be UN-muted so it continues the conversation');
});

test('relay falls back to the verbatim team answer when the AI rephrase fails', async () => {
  const database = fakeDbCapture([{ re: /INSERT INTO messages/, rows: [{ id: 'reply-1' }] }]);
  const enqueued = [];
  const thread = { customer_sender: '9665@s.whatsapp.net', target_jid: '120363@g.us', conversation_id: 'c1' };
  const result = await relayResolutionToCustomer({
    database,
    enqueue: async (payload, opts) => { enqueued.push({ payload, opts }); },
    rephrase: async () => { throw new Error('ai down'); },
    userId: 'u1',
    thread,
    text: 'تم حل المشكلة، الطلب ينوصل بكرة',
  });
  assert.equal(result.relayed, true);
  assert.equal(enqueued[0].payload.reply, 'تم حل المشكلة، الطلب ينوصل بكرة', 'verbatim beats silence');
});

test('relayResolutionToCustomer skips empty text without side effects', async () => {
  const database = fakeDbCapture();
  const result = await relayResolutionToCustomer({
    database, enqueue: async () => { throw new Error('must not enqueue'); },
    userId: 'u1', thread: { customer_sender: 'x' }, text: '   ',
  });
  assert.equal(result.relayed, false);
});

test('buildCustomerForwardText includes customer label, text, and quote instruction', () => {
  const text = buildCustomerForwardText({ customerSender: '966512345678@s.whatsapp.net', text: 'وش صار على طلبي؟' });
  assert.match(text, /966512345678/);
  assert.match(text, /وش صار على طلبي؟/);
  assert.match(text, /رد على هذه الرسالة/);
});
