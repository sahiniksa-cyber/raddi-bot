'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBotController } = require('../src/controllers/bot.controller');

function makeDb(overrides = {}) {
  const queries = [];
  return {
    queries,
    isConfigured: () => true,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO conversations') || sql.includes('ON CONFLICT')) {
        return { rows: [{ id: 'conv-id-1' }] };
      }
      if (sql.includes('INSERT INTO messages')) {
        return { rows: [{ id: 'msg-id-1' }] };
      }
      return { rows: [] };
    },
    ...overrides,
  };
}

function makeBot({ connected = true } = {}) {
  return {
    userId: 'user-1',
    botRunning: connected,
    appState: { status: connected ? 'connected' : 'stopped' },
    client: connected ? {
      sendMessage: async () => {},
    } : null,
    log: () => {},
  };
}

function makeReq(body = {}) {
  return {
    session: { userId: 'user-1' },
    body: { phone: '966501234567', message: 'مرحبا', ...body },
  };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

test('sendMessage stores outbound message to DB after successful send', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, true);

  const convQuery = database.queries.find(q => q.sql.includes('INSERT INTO conversations'));
  assert.ok(convQuery, 'should upsert conversation');
  assert.equal(convQuery.params[0], 'user-1');
  assert.ok(convQuery.params[1].includes('966501234567'), 'sender should include phone number');

  const msgQuery = database.queries.find(q => q.sql.includes('INSERT INTO messages'));
  assert.ok(msgQuery, 'should insert outbound message');
  assert.equal(msgQuery.params[1], 'user-1'); // user_id
  assert.ok(msgQuery.params[3] === 'مرحبا', 'content should match sent message');
});

test('sendMessage does not attempt DB write when bot is not connected', async () => {
  const database = makeDb();
  const bot = makeBot({ connected: false });
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, false);
  assert.equal(database.queries.length, 0, 'no DB calls when bot not connected');
});

test('sendMessage does not crash when database is not configured', async () => {
  const database = makeDb({ isConfigured: () => false });
  const bot = makeBot();
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, true, 'should still succeed even if DB not configured');
});

test('sendMessage rejects missing phone or message', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({ getUserBot: () => bot, database });

  const res = makeRes();
  await ctrl.sendMessage(makeReq({ phone: '' }), res);
  assert.equal(res._status, 400);
});

test('sendMessage uses an explicit sender JID when phone is unavailable (e.g. @lid)', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({ getUserBot: () => bot, database });

  const req = { session: { userId: 'user-1' }, body: { sender: '12345@lid', message: 'مرحبا' } };
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, true);
  const convQuery = database.queries.find(q => q.sql.includes('INSERT INTO conversations'));
  assert.equal(convQuery.params[1], '12345@lid', 'must send/store using the raw JID, not a phone-built one');
});

test('sendMessage pauses the AI on the conversation for 30 minutes (manual reply)', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({ getUserBot: () => bot, database });

  await ctrl.sendMessage(makeReq(), makeRes());

  const muteQuery = database.queries.find(q => q.sql.includes('escalated_until'));
  assert.ok(muteQuery, 'manual send must mute the AI so it does not talk over the human');
  assert.equal(muteQuery.params[0], 'conv-id-1', 'mute targets the resolved conversation');
});

test('sendMessage honors the merchant configured ownerPauseMinutes (not a hardcoded 30)', async () => {
  // bot_configs returns a configured 45 — the dashboard path must use it.
  const database = makeDb({
    query: async (sql, params) => {
      database.queries.push({ sql, params });
      if (sql.includes("config->>'ownerPauseMinutes'")) {
        return { rows: [{ owner_pause_minutes: '45' }] };
      }
      if (sql.includes('INSERT INTO conversations') || sql.includes('ON CONFLICT')) {
        return { rows: [{ id: 'conv-id-1' }] };
      }
      if (sql.includes('INSERT INTO messages')) return { rows: [{ id: 'msg-id-1' }] };
      return { rows: [] };
    },
  });
  const ctrl = createBotController({ getUserBot: () => makeBot(), database });

  await ctrl.sendMessage(makeReq(), makeRes());

  const muteQuery = database.queries.find(q => q.sql.includes('SET escalated_until'));
  assert.ok(muteQuery, 'manual send must set the takeover window');
  assert.equal(muteQuery.params[0], 'conv-id-1');
  assert.equal(muteQuery.params[1], 45, 'must use the configured 45 minutes, not a hardcoded 30');
  assert.ok(/\$2 \* INTERVAL '1 minute'/.test(muteQuery.sql), 'window must be computed from configured minutes');
});

test('sendMessage skips the pause when the merchant disabled it (ownerPauseMinutes=0)', async () => {
  const database = makeDb({
    query: async (sql, params) => {
      database.queries.push({ sql, params });
      if (sql.includes("config->>'ownerPauseMinutes'")) return { rows: [{ owner_pause_minutes: '0' }] };
      if (sql.includes('INSERT INTO conversations') || sql.includes('ON CONFLICT')) return { rows: [{ id: 'conv-id-1' }] };
      if (sql.includes('INSERT INTO messages')) return { rows: [{ id: 'msg-id-1' }] };
      return { rows: [] };
    },
  });
  const ctrl = createBotController({ getUserBot: () => makeBot(), database });

  await ctrl.sendMessage(makeReq(), makeRes());

  const muteQuery = database.queries.find(q => q.sql.includes('SET escalated_until'));
  assert.equal(muteQuery, undefined, 'no pause is set when the merchant disabled it');
});
