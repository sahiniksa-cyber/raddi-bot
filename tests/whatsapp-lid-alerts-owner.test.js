'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub db before loading the worker so markReplyMessage / updateJobStatus don't try
// to talk to a real database.
const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath,
  filename: dbModulePath + '.js',
  loaded: true,
  exports: {
    isConfigured: () => true,
    query: async () => ({ rows: [] }),
    getDatabaseUrl: () => 'stub',
    close: async () => {},
  },
};

const {
  processOutgoingWhatsapp,
  notifyOwnerOfLidFailure,
} = require('../src/workers/outgoing-whatsapp-worker');

function makeJob(data = {}) {
  return {
    id: 'job-lid-1',
    data: {
      userId: 'user-1',
      sender: '278571713060916@lid',
      reply: 'مرحبا',
      replyMessageId: 'reply-1',
      ...data,
    },
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

test('@lid send failure triggers owner notification with Arabic alert', async () => {
  const prev = process.env.OWNER_ALERT_PHONE;
  process.env.OWNER_ALERT_PHONE = '966500000000';

  try {
    const sendCalls = [];
    const fakeBot = {
      appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
      sessionDesiredState: 'running',
      startBot: async () => {},
      // bot.client is the live-socket wrapper; the outgoing worker routes
      // ALL sends through it (never bot.sock directly — that would pin a
      // stale socket reference across reconnects).
      client: {
        sendMessage: async (target, text) => {
          sendCalls.push({ jid: target, text });
          if (target.endsWith('@lid')) throw new Error('lid_undeliverable');
          return { key: { id: 'ok', remoteJid: target, fromMe: true } };
        },
        sendPresenceUpdate: async () => {},
      },
      sock: { ws: { readyState: 1 } },
      log: () => {},
    };

    const getUserBot = async () => fakeBot;

    const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'sender_is_lid_only');

    const lidAttempt = sendCalls.find(c => c.jid.endsWith('@lid'));
    const ownerAlert = sendCalls.find(c => c.jid === '966500000000@s.whatsapp.net');
    assert.ok(lidAttempt, 'must attempt best-effort send to @lid first');
    assert.ok(ownerAlert, 'must notify owner @s.whatsapp.net after failure');
    assert.match(ownerAlert.text, /تعذّر/);
    assert.match(ownerAlert.text, /lid:/);
    assert.match(ownerAlert.text, /278571713060916@lid/);
  } finally {
    if (prev === undefined) delete process.env.OWNER_ALERT_PHONE;
    else process.env.OWNER_ALERT_PHONE = prev;
  }
});

test('notifyOwnerOfLidFailure no-ops when OWNER_ALERT_PHONE is unset', async () => {
  const prev = process.env.OWNER_ALERT_PHONE;
  delete process.env.OWNER_ALERT_PHONE;
  try {
    const sent = [];
    const getUserBot = async () => ({
      appState: { status: 'connected' },
      client: { sendMessage: async (jid, text) => sent.push({ jid, text }) },
    });
    const ok = await notifyOwnerOfLidFailure({
      userId: 'u',
      sender: '123@lid',
      getUserBot,
    });
    assert.equal(ok, false);
    assert.equal(sent.length, 0);
  } finally {
    if (prev !== undefined) process.env.OWNER_ALERT_PHONE = prev;
  }
});

test('@lid best-effort send that succeeds marks job completed (no alert)', async () => {
  const prev = process.env.OWNER_ALERT_PHONE;
  process.env.OWNER_ALERT_PHONE = '966500000000';
  try {
    const sendCalls = [];
    const getUserBot = async () => ({
      appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
      client: {
        sendMessage: async (target, text) => {
          sendCalls.push({ jid: target, text });
          return { key: { id: 'ok', remoteJid: target, fromMe: true } };
        },
        sendPresenceUpdate: async () => {},
      },
      sock: { ws: { readyState: 1 } },
      sessionDesiredState: 'running',
      startBot: async () => {},
      log: () => {},
    });

    const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });
    assert.equal(result.sent, true);
    assert.equal(result.lid, true);
    // Only the customer send — no owner alert
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].jid, '278571713060916@lid');
  } finally {
    if (prev === undefined) delete process.env.OWNER_ALERT_PHONE;
    else process.env.OWNER_ALERT_PHONE = prev;
  }
});
