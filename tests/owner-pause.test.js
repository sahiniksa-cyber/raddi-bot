'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerPauseExpiry, MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

test('ownerPauseExpiry returns now+minutes as Date', () => {
  const now = 1_000_000;
  const d = ownerPauseExpiry(30, now);
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), now + 30 * 60 * 1000);
});

test('ownerPauseExpiry returns null when minutes is 0 or invalid (pause disabled)', () => {
  assert.equal(ownerPauseExpiry(0, 1000), null);
  assert.equal(ownerPauseExpiry(undefined, 1000), null);
  assert.equal(ownerPauseExpiry(-5, 1000), null);
  assert.equal(ownerPauseExpiry('abc', 1000), null);
});

test('ownerPauseExpiry accepts numeric strings (config values come as strings)', () => {
  const now = 2_000_000;
  const d = ownerPauseExpiry('45', now);
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), now + 45 * 60 * 1000);
});

// Integration: fromMe (owner manual reply) sets conversations.escalated_until.
function createFakeDb({ ownerPauseMinutes = null } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    // Top-level query is used to read ownerPauseMinutes and to UPDATE escalated_until.
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) {
        return { rows: [{ owner_pause_minutes: ownerPauseMinutes }] };
      }
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id, phone_number/.test(sql) && /conversations/.test(sql)) {
          return { rows: [{ id: 'conv-1', phone_number: params?.[2] ?? null }] };
        }
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) {
          return { rows: [{ id: 'msg-1' }] };
        }
        return { rows: [] };
      },
    }),
  };
}

function fromMeMsg() {
  return {
    id: { id: 'owner-1' },
    from: '966512345678@c.us',
    fromMe: true,
    body: 'تم تجهيز طلبك',
  };
}

test('fromMe owner reply sets escalated_until using ownerPauseMinutes from config', async () => {
  const database = createFakeDb({ ownerPauseMinutes: 45 });
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: () => {} } });

  const res = await service.ingestWhatsappMessage({ userId: 'user-1', msg: fromMeMsg(), source: 'baileys' });
  assert.equal(res.fromMe, true);

  const update = database.calls.find(c => /UPDATE conversations SET escalated_until/.test(c.sql));
  assert.ok(update, 'must UPDATE conversations.escalated_until');
  assert.equal(update.params[0], 'conv-1', 'first param is conversationId');
  assert.ok(update.params[1] instanceof Date, 'second param is expiry Date');
});

test('fromMe owner reply defaults to 30 minutes when config has no ownerPauseMinutes', async () => {
  const database = createFakeDb({ ownerPauseMinutes: null });
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: () => {} } });

  const before = Date.now();
  await service.ingestWhatsappMessage({ userId: 'user-1', msg: fromMeMsg(), source: 'baileys' });
  const update = database.calls.find(c => /UPDATE conversations SET escalated_until/.test(c.sql));
  assert.ok(update, 'must UPDATE conversations.escalated_until with default 30');
  const expiry = update.params[1];
  assert.ok(expiry instanceof Date);
  // ~30 minutes ahead (allow generous slack for test execution time)
  const deltaMin = (expiry.getTime() - before) / 60000;
  assert.ok(deltaMin > 29 && deltaMin < 31, `expected ~30 min, got ${deltaMin}`);
});

test('fromMe owner reply does NOT pause when ownerPauseMinutes is 0', async () => {
  const database = createFakeDb({ ownerPauseMinutes: 0 });
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: () => {} } });

  await service.ingestWhatsappMessage({ userId: 'user-1', msg: fromMeMsg(), source: 'baileys' });
  const update = database.calls.find(c => /UPDATE conversations SET escalated_until/.test(c.sql));
  assert.equal(update, undefined, 'must not set escalated_until when pause disabled');
});

test('fromMe pause failure does not break message ingest', async () => {
  const database = createFakeDb({ ownerPauseMinutes: 30 });
  // Make the UPDATE throw; ingest must still succeed.
  const origQuery = database.query;
  database.query = async (sql, params) => {
    if (/UPDATE conversations SET escalated_until/.test(sql)) throw new Error('boom');
    return origQuery(sql, params);
  };
  const warnings = [];
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: (...a) => warnings.push(a) } });

  const res = await service.ingestWhatsappMessage({ userId: 'user-1', msg: fromMeMsg(), source: 'baileys' });
  assert.equal(res.accepted, true, 'ingest must still succeed');
});
