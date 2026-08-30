'use strict';

// Human Takeover — configured duration (spec point 4), extension (point 5),
// "stays canceled after expiry" (point 8/L), and the generation-time mute that
// keeps the bot silent for new customer inbound during takeover (point 6/B).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_OWNER_PAUSE_MINUTES,
  parseOwnerPauseMinutes,
  readOwnerPauseMinutes,
} = require('../src/services/whatsapp/owner-pause-config');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { isConversationOwnerPaused } = require('../src/workers/outgoing-whatsapp-worker');
const { isConversationEscalationMuted } = require('../src/workers/ai-worker');

// ── Point 4: configured duration is honored; missing/invalid → platform default.
test('parseOwnerPauseMinutes: configured value wins; missing/invalid → platform default', () => {
  assert.equal(parseOwnerPauseMinutes('45'), 45, 'a configured value must be used verbatim');
  assert.equal(parseOwnerPauseMinutes(45), 45);
  assert.equal(parseOwnerPauseMinutes(null), DEFAULT_OWNER_PAUSE_MINUTES, 'missing → default');
  assert.equal(parseOwnerPauseMinutes(undefined), DEFAULT_OWNER_PAUSE_MINUTES, 'missing → default');
  assert.equal(parseOwnerPauseMinutes('abc'), DEFAULT_OWNER_PAUSE_MINUTES, 'invalid → default');
  assert.equal(parseOwnerPauseMinutes('0'), 0, '0 = merchant disabled the pause (kept verbatim)');
});

test('readOwnerPauseMinutes: reads per-merchant config and falls back on error', async () => {
  const okDb = { query: async () => ({ rows: [{ owner_pause_minutes: '45' }] }) };
  assert.equal(await readOwnerPauseMinutes(okDb, 'user-1'), 45);

  const missingDb = { query: async () => ({ rows: [{ owner_pause_minutes: null }] }) };
  assert.equal(await readOwnerPauseMinutes(missingDb, 'user-1'), DEFAULT_OWNER_PAUSE_MINUTES);

  const throwDb = { query: async () => { throw new Error('boom'); } };
  assert.equal(await readOwnerPauseMinutes(throwDb, 'user-1'), DEFAULT_OWNER_PAUSE_MINUTES);
});

// ── Point 5 / test D: each genuine owner reply EXTENDS the window
// (takeover_until = latest owner reply time + configured duration).
function createExtensionDb({ ownerPauseMinutes }) {
  const updates = [];
  return {
    updates,
    isConfigured: () => true,
    query: async (sql, params) => {
      if (/FROM bot_configs/.test(sql)) return { rows: [{ owner_pause_minutes: ownerPauseMinutes }] };
      if (/UPDATE conversations[\s\S]*SET escalated_until/.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'conv-1', phone_number: null }] };
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) return { rows: [{ id: 'msg-x', created_at: new Date().toISOString() }] };
        return { rows: [] };
      },
    }),
  };
}

function ownerMsg(id, body) {
  return { id: { id }, from: '966512345678@c.us', fromMe: true, body };
}

test('D — a second genuine owner reply extends the takeover window', async () => {
  const database = createExtensionDb({ ownerPauseMinutes: 45 });
  const service = new MessageIngestService({ database, logger: { info: () => {}, warn: () => {} } });

  await service.ingestWhatsappMessage({ userId: 'user-1', msg: ownerMsg('owner-1', 'رد أول'), source: 'baileys' });
  const firstExpiry = database.updates.at(-1)[1];

  // A short, real wall-clock gap so the second computed expiry is strictly later.
  await new Promise(r => setTimeout(r, 15));

  await service.ingestWhatsappMessage({ userId: 'user-1', msg: ownerMsg('owner-2', 'رد ثانٍ'), source: 'baileys' });
  const secondExpiry = database.updates.at(-1)[1];

  assert.ok(firstExpiry instanceof Date && secondExpiry instanceof Date);
  assert.ok(
    secondExpiry.getTime() > firstExpiry.getTime(),
    'the second owner reply must push the takeover window further out (extension, not set-once)',
  );
});

// ── Point 8 / test L: an AI reply canceled because the owner took over must
// STAY blocked even after the time window expires — the fact-based signal (an
// owner reply row created at/after the AI reply) is permanent.
function createFactBasedDb({ aiCreatedAt, humanCreatedAt, escalatedUntil }) {
  return {
    isConfigured: () => true,
    query: async (sql) => {
      if (/SELECT escalated_until FROM conversations/.test(sql)) {
        return { rows: [{ escalated_until: escalatedUntil }] };
      }
      if (/JOIN messages hum/.test(sql)) {
        // humanCreatedAt >= aiCreatedAt → the owner stepped in on this reply.
        return { rows: humanCreatedAt >= aiCreatedAt ? [{ x: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('L — a pre-takeover reply stays canceled after the window expires (permanent fact-based block)', async () => {
  const t0 = Date.now();
  const database = createFactBasedDb({
    aiCreatedAt: t0,
    humanCreatedAt: t0 + 1000, // owner replied just after the AI reply was generated
    escalatedUntil: new Date(t0 - 60_000), // …and the time window has ALREADY expired
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1',
    sender: '966500000000@s.whatsapp.net',
    replyMessageId: 'ai-old',
    database,
  });
  assert.equal(paused, true, 'the old reply must never resurrect once an owner reply is on record');
});

// ── Point 6 / test B: while takeover is active, the AI worker must not even
// GENERATE a reply to a new customer message.
test('B — generation is muted for new customer inbound during an active takeover', async () => {
  const mutedDb = {
    isConfigured: () => true,
    query: async () => ({ rows: [{ escalated_until: new Date(Date.now() + 60_000) }] }),
  };
  assert.equal(
    await isConversationEscalationMuted({ database: mutedDb, userId: 'u1', conversationId: 'c1' }),
    true,
    'a new customer message during takeover must not trigger AI generation',
  );

  const clearDb = {
    isConfigured: () => true,
    query: async () => ({ rows: [] }),
  };
  assert.equal(
    await isConversationEscalationMuted({ database: clearDb, userId: 'u1', conversationId: 'c1' }),
    false,
  );
});
