'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub the db module before loading the worker so that markReplyMessage
// doesn't try to connect to a real database.
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
} = require('../src/workers/outgoing-whatsapp-worker');

function makeJob(data = {}) {
  return {
    id: 'job-1',
    data: {
      userId: 'user-1',
      sender: '278571713060916@lid',
      reply: 'مرحبا',
      replyMessageId: 'msg-1',
      ...data,
    },
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

test('processOutgoingWhatsapp skips @lid sender without calling getUserBot', async (t) => {
  // getUserBot must NOT be called for @lid senders
  const getUserBot = t.mock.fn(() => {
    throw new Error('getUserBot must not be called for @lid sender');
  });

  const result = await processOutgoingWhatsapp(makeJob(), { getUserBot });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'sender_is_lid_only');
  assert.equal(getUserBot.mock.calls.length, 0, 'getUserBot must NOT be called');
});

test('processOutgoingWhatsapp does NOT skip normal @s.whatsapp.net sender', async (t) => {
  let getUserBotCalled = false;
  const getUserBot = () => {
    getUserBotCalled = true;
    // Throw to stop execution early — we only care that we got past the @lid check
    throw new Error('intentional stop after @lid guard passed');
  };

  try {
    await processOutgoingWhatsapp(makeJob({ sender: '966501234567@s.whatsapp.net' }), { getUserBot });
  } catch (err) {
    // Expected — we threw from getUserBot on purpose
    assert.match(err.message, /intentional stop/);
  }

  assert.equal(getUserBotCalled, true, 'getUserBot must be called for normal sender');
});

test('@c.us sender is normal phone-based JID and must not be treated as @lid', async (t) => {
  // Only @lid suffix should be guarded; @c.us is a normal phone-based JID
  let getUserBotCalled = false;
  const getUserBot = () => {
    getUserBotCalled = true;
    throw new Error('intentional stop');
  };

  try {
    await processOutgoingWhatsapp(makeJob({ sender: '966501234567@c.us' }), { getUserBot });
  } catch (err) {
    assert.match(err.message, /intentional stop/);
  }
  assert.equal(getUserBotCalled, true, '@c.us must NOT be treated as @lid');
});
