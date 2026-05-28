'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub db before loading the worker.
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

// Track decrementMessageQuota calls by stubbing the billing module BEFORE requiring
// the worker. Use the same trick used elsewhere in this repo.
const quotaModulePath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
let decrementCalls = 0;
require.cache[require.resolve(quotaModulePath)] = {
  id: quotaModulePath,
  filename: quotaModulePath + '.js',
  loaded: true,
  exports: {
    decrementMessageQuota: async () => {
      decrementCalls++;
      return { success: true, remaining: 100 };
    },
  },
};

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');

function makeJob(overrides = {}) {
  return {
    id: 'job-q-1',
    data: {
      userId: 'user-1',
      sender: '966500000001@s.whatsapp.net',
      reply: 'مرحبا',
      replyMessageId: 'reply-1',
      ...overrides,
    },
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

test('quota is NOT decremented when sendWhatsappReply throws', async () => {
  decrementCalls = 0;

  const getUserBot = async () => ({
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running',
    startBot: async () => {},
    sock: {
      ws: { readyState: 1 },
      sendPresenceUpdate: async () => {},
    },
    client: {
      sendMessage: async () => { throw new Error('simulated_send_failure'); },
    },
    log: () => {},
  });

  await assert.rejects(
    processOutgoingWhatsapp(makeJob(), { getUserBot }),
    /simulated_send_failure/,
  );
  assert.equal(decrementCalls, 0, 'quota must not be decremented when the send fails');
});

test('quota is NOT decremented when socket is not open', async () => {
  decrementCalls = 0;

  const getUserBot = async () => ({
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running',
    startBot: async () => {},
    sock: {
      ws: { readyState: 3 }, // CLOSED
      sendPresenceUpdate: async () => {},
    },
    client: { sendMessage: async () => {} },
    log: () => {},
  });

  await assert.rejects(
    processOutgoingWhatsapp(makeJob(), { getUserBot }),
    /socket_not_open/,
  );
  assert.equal(decrementCalls, 0);
});

test('quota IS decremented exactly once on a successful send', async () => {
  decrementCalls = 0;
  const prev = process.env.OUTGOING_MIN_INTERVAL_MS;
  process.env.OUTGOING_MIN_INTERVAL_MS = '0'; // disable pacing for fast test

  try {
    const getUserBot = async () => ({
      appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
      sessionDesiredState: 'running',
      startBot: async () => {},
      sock: {
        ws: { readyState: 1 },
        sendPresenceUpdate: async () => {},
      },
      client: { sendMessage: async () => ({ id: 'ok' }) },
      log: () => {},
    });

    const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });
    assert.equal(result.sent, true);
    assert.equal(decrementCalls, 1);
  } finally {
    if (prev === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
    else process.env.OUTGOING_MIN_INTERVAL_MS = prev;
  }
});
