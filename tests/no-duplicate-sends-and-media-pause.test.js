'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isReplyAlreadySent } = require('../src/workers/outgoing-whatsapp-worker');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

// ── Bug A (owner report 2026-06-12): the same reply reaches the customer
// TWICE ~30min apart. Root: every restart resurrects <30min-old jobs whose DB
// row never reached 'completed' (process died right after the send) → resend.
// Idempotency guard: a reply whose message row is already sent must never
// ship again.

test('isReplyAlreadySent detects an already-delivered reply (status sent / whatsapp id recorded)', async () => {
  const dbSent = { isConfigured: () => true, query: async () => ({ rows: [{ status: 'sent', whatsapp_message_id: null }] }) };
  assert.equal(await isReplyAlreadySent({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: dbSent,
  }), true);

  const dbWaId = { isConfigured: () => true, query: async () => ({ rows: [{ status: 'queued_for_send', whatsapp_message_id: 'WAMID9' }] }) };
  assert.equal(await isReplyAlreadySent({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: dbWaId,
  }), true, 'a recorded WhatsApp id proves delivery');
});

test('isReplyAlreadySent fails open (send) on unknown/missing data', async () => {
  const dbQueued = { isConfigured: () => true, query: async () => ({ rows: [{ status: 'queued_for_send', whatsapp_message_id: null }] }) };
  assert.equal(await isReplyAlreadySent({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: dbQueued,
  }), false);
  assert.equal(await isReplyAlreadySent({ replyMessageId: null, database: dbQueued }), false, 'no id → cannot check → send');
  const dbErr = { isConfigured: () => true, query: async () => { throw new Error('boom'); } };
  assert.equal(await isReplyAlreadySent({
    replyMessageId: 'r1', userId: 'u1', conversationId: 'c1', database: dbErr,
  }), false, 'db hiccup must not block replies');
});

test('the outgoing chokepoint checks already-sent BEFORE sending (both paths)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  const mainSend = src.indexOf('await sendWhatsappReply');
  const mainGuard = src.indexOf('isReplyAlreadySent', src.indexOf('async function processOutgoingWhatsapp'));
  assert.ok(mainGuard > -1 && mainGuard < mainSend, 'main path must guard before the send');
  const lidStart = src.indexOf('async function handleLidOutgoing');
  const lidEnd = src.indexOf('async function notifyOwnerOfLidFailure');
  assert.match(src.slice(lidStart, lidEnd), /isReplyAlreadySent/, '@lid path must guard too');
});

// ── Bug B (owner report 2026-06-12): the bot keeps replying while the owner
// is talking to the customer. Root: a media-only owner reply (image/file, no
// text) returned from_me_empty BEFORE the 30-minute pause was applied.

test('a media-only fromMe owner reply still pauses the bot for 30 minutes', async () => {
  const calls = [];
  const database = {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ owner_pause_minutes: 30 }] };
      if (/INSERT INTO conversations/.test(sql)) return { rows: [{ id: 'conv-9', phone_number: null }] };
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'conv-9', phone_number: null }] };
        return { rows: [] };
      },
    }),
  };
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: () => {} } });

  const result = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'OWNER-IMG' }, from: '966512345678@s.whatsapp.net', fromMe: true, body: '' }, // image-only, no media payload surfaced
    source: 'baileys',
  });

  assert.equal(result.paused, true, `owner sent SOMETHING — the bot must back off: ${JSON.stringify(result)}`);
  const pause = calls.find(c => /SET escalated_until/.test(c.sql));
  assert.ok(pause, 'escalated_until must be set even when the owner reply has no text');
});
