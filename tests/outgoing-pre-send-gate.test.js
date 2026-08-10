'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const dbModulePath = path.resolve(__dirname, '..', 'src', 'db', 'client');
require.cache[require.resolve(dbModulePath)] = {
  id: dbModulePath,
  filename: dbModulePath + '.js',
  loaded: true,
  exports: {
    isConfigured: () => true,
    query: async () => ({ rows: [], rowCount: 0 }),
    getDatabaseUrl: () => 'stub',
    close: async () => {},
  },
};

const quotaModulePath = path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota');
require.cache[require.resolve(quotaModulePath)] = {
  id: quotaModulePath,
  filename: quotaModulePath + '.js',
  loaded: true,
  exports: {
    checkMessageQuota: async () => ({ canReply: true, remaining: 10 }),
    decrementMessageQuota: async () => ({ success: true, remaining: 9 }),
  },
};

const { processOutgoingWhatsapp } = require('../src/workers/outgoing-whatsapp-worker');
const validateScope = async () => ({ content: null });

function makeJob(sender = '966500000001@s.whatsapp.net') {
  return {
    id: 'job-pre-send-1',
    data: {
      userId: 'user-1',
      conversationId: 'conversation-1',
      sender,
      reply: 'مسودة غير مراجعة',
      replyMessageId: 'reply-1',
      source: 'ai_reply',
      preSendReviewRequired: true,
      replyState: 'queued_for_send',
    },
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

function makeBot(sent) {
  return {
    appState: { status: 'connected', statusAgeMs: 99999, whatsappEngine: 'baileys' },
    sessionDesiredState: 'running',
    startBot: async () => {},
    sock: { ws: { readyState: 1 } },
    client: {
      sendPresenceUpdate: async () => {},
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
        return { key: { id: 'wa-1' } };
      },
    },
    log: () => {},
  };
}

test('normal WhatsApp path sends only the final reviewed text', async () => {
  const previous = process.env.OUTGOING_MIN_INTERVAL_MS;
  process.env.OUTGOING_MIN_INTERVAL_MS = '0';
  const sent = [];
  try {
    const result = await processOutgoingWhatsapp(makeJob(), {
      getUserBot: async () => makeBot(sent),
      scopeValidator: validateScope,
      reviewBeforeSend: async () => ({
        reply: 'النص النهائي المراجع',
        suppressed: false,
        audit: { validationDecision: 'validated' },
      }),
    });
    assert.equal(result.sent, true);
    assert.deepEqual(sent.map(item => item.text), ['النص النهائي المراجع']);
  } finally {
    if (previous === undefined) delete process.env.OUTGOING_MIN_INTERVAL_MS;
    else process.env.OUTGOING_MIN_INTERVAL_MS = previous;
  }
});

test('suppressed duplicate completes without any WhatsApp send', async () => {
  const sent = [];
  const result = await processOutgoingWhatsapp(makeJob(), {
    getUserBot: async () => makeBot(sent),
    scopeValidator: validateScope,
    reviewBeforeSend: async () => ({ reply: '', suppressed: true }),
  });
  assert.equal(result.reason, 'pre_send_suppressed');
  assert.equal(sent.length, 0);
});

test('review failure is fail-closed on the normal path', async () => {
  const sent = [];
  await assert.rejects(
    processOutgoingWhatsapp(makeJob(), {
      getUserBot: async () => makeBot(sent),
      scopeValidator: validateScope,
      reviewBeforeSend: async () => { throw new Error('review timeout'); },
    }),
    /review timeout/,
  );
  assert.equal(sent.length, 0);
});
test('review failure is retried, not swallowed, on the @lid path', async () => {
  const sent = [];
  await assert.rejects(
    processOutgoingWhatsapp(makeJob('278571713060916@lid'), {
      getUserBot: async () => makeBot(sent),
      scopeValidator: validateScope,
      reviewBeforeSend: async () => { throw new Error('review timeout'); },
    }),
    /review timeout/,
  );
  assert.equal(sent.length, 0);
});

test('disabled auto-reply cancels an already queued AI reply before review or send', async () => {
  let botLookups = 0;
  let reviews = 0;
  const result = await processOutgoingWhatsapp(makeJob(), {
    getUserBot: async () => {
      botLookups++;
      return makeBot([]);
    },
    scopeValidator: validateScope,
    reviewBeforeSend: async () => {
      reviews++;
      return { reply: 'should never send', suppressed: false };
    },
    getAutoReplyEnabled: async () => false,
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: 'auto_reply_disabled',
  });
  assert.equal(botLookups, 0);
  assert.equal(reviews, 0);
});
