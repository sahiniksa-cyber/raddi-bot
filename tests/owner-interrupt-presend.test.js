'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConversationOwnerPaused } = require('../src/workers/outgoing-whatsapp-worker');

// ── Issue 2 (owner report): the human owner manually replies to the customer
// FAST, but the bot's in-flight AI reply (queued behind the 50-75s humanization
// delay) still lands AFTER the owner's reply → a double / conflicting answer.
//
// The pre-send gate `isConversationOwnerPaused` must cancel the in-flight AI
// reply the moment an owner/human reply is on record. It has two signals:
//   1. flag-based: conversations.escalated_until > NOW()
//   2. fact-based: a human outbound row created after the AI reply row.
//
// This file pins the fact-based fallback, which is the last line of defense when
// escalated_until was not set (or was cleared). The bug: the fact-based query
// used a STRICT `hum.created_at > ai.created_at`, so a fast owner reply landing
// in the SAME millisecond as the AI row's insert time (very common — the AI row
// is inserted at generation and the owner can reply within the same tick the DB
// stamps, and NOW() resolution can collide) was MISSED, letting the AI reply
// through.

// Faithful in-memory simulation of the fact-based SQL join in
// isConversationOwnerPaused. Rows model the `messages` table.
function createFactBasedDb({ rows }) {
  return {
    isConfigured: () => true,
    query: async (sql, params) => {
      // flag-based check: SELECT escalated_until FROM conversations ...
      if (/SELECT escalated_until FROM conversations/.test(sql)) {
        return { rows: [{ escalated_until: null }] }; // simulate: flag NOT set
      }
      // fact-based check: the JOIN on conversation_id finding a later human reply.
      if (/JOIN messages hum/.test(sql)) {
        const aiId = params[0];
        const ai = rows.find((r) => r.id === aiId);
        if (!ai) return { rows: [] };
        // Reproduce the WHERE clause's comparison operator faithfully.
        const cmpGreaterOrEqual = /hum\.created_at >= ai\.created_at/.test(sql);
        const match = rows.some((hum) => {
          if (hum.id === ai.id) return false;
          if (hum.conversation_id !== ai.conversation_id) return false;
          if (hum.direction !== 'outbound') return false;
          const isHuman =
            hum.status === 'sent_by_human' ||
            (hum.status === 'sent' && hum.raw_payload?.source === 'manual_send');
          if (!isHuman) return false;
          const after = cmpGreaterOrEqual
            ? hum.created_at >= ai.created_at
            : hum.created_at > ai.created_at;
          return after;
        });
        return { rows: match ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('cancels the in-flight AI reply when a phone owner reply lands AFTER it (baseline)', async () => {
  const t0 = 1_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-1', conversation_id: 'c1', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      { id: 'hum-1', conversation_id: 'c1', direction: 'outbound', status: 'sent_by_human', created_at: t0 + 5000 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-1', database,
  });
  assert.equal(paused, true, 'a clearly-later owner reply must cancel the AI reply');
});

test('cancels the in-flight AI reply when the owner replies in the SAME tick (fast reply)', async () => {
  // The exact production complaint: owner replies FAST. The human row lands with
  // the SAME created_at as the AI row (same millisecond / NOW() resolution).
  const t0 = 1_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-1', conversation_id: 'c1', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      { id: 'hum-1', conversation_id: 'c1', direction: 'outbound', status: 'sent_by_human', created_at: t0 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-1', database,
  });
  assert.equal(paused, true, 'a same-millisecond fast owner reply must STILL cancel the AI reply');
});

test('cancels for a dashboard manual_send that lands in the same tick', async () => {
  const t0 = 2_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-2', conversation_id: 'c2', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      { id: 'man-1', conversation_id: 'c2', direction: 'outbound', status: 'sent', raw_payload: { source: 'manual_send' }, created_at: t0 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-2', database,
  });
  assert.equal(paused, true, 'a same-tick dashboard manual reply must cancel the AI reply');
});

test('does NOT cancel when the only later outbound row is the bot itself (no self-cancel)', async () => {
  const t0 = 3_000_000;
  const database = createFactBasedDb({
    rows: [
      { id: 'ai-3', conversation_id: 'c3', direction: 'outbound', status: 'queued_for_send', created_at: t0 },
      // another AI send, NOT a human reply
      { id: 'ai-3b', conversation_id: 'c3', direction: 'outbound', status: 'sent', raw_payload: { source: 'ai' }, created_at: t0 + 1000 },
    ],
  });
  const paused = await isConversationOwnerPaused({
    userId: 'u1', sender: '966500000000@s.whatsapp.net', replyMessageId: 'ai-3', database,
  });
  assert.equal(paused, false, 'the bot must not cancel itself on its own later AI send');
});
