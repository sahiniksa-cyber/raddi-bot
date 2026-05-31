'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { expireStaleQueuedMessages } = require('../src/workers/ai-recovery');
const { loadPendingInboundMessages } = require('../src/workers/ai-worker');

function fakeDb(rowCount, capture) {
  return {
    isConfigured: () => true,
    query: async (sql, params) => {
      if (capture) capture.push({ sql, params });
      return { rowCount, rows: [] };
    },
  };
}

test('expireStaleQueuedMessages retires stale queued_for_ai messages', async () => {
  const capture = [];
  const res = await expireStaleQueuedMessages({ database: fakeDb(130, capture), maxAgeMs: 1800000 });
  assert.equal(res.expired, 130);
  // It UPDATEs inbound queued_for_ai rows older than the window to ai_failed.
  assert.match(capture[0].sql, /UPDATE messages/i);
  assert.match(capture[0].sql, /status = 'ai_failed'/);
  assert.match(capture[0].sql, /status = 'queued_for_ai'/);
  assert.match(capture[0].sql, /direction = 'inbound'/);
});

test('expireStaleQueuedMessages no-ops when DB not configured', async () => {
  const res = await expireStaleQueuedMessages({ database: { isConfigured: () => false } });
  assert.equal(res.expired, 0);
});

test('loadPendingInboundMessages no longer filters on raw_payload.timestamp', async () => {
  const capture = [];
  await loadPendingInboundMessages({
    database: {
      isConfigured: () => true,
      query: async (sql, params) => { capture.push({ sql, params }); return { rows: [] }; },
    },
    userId: 'u1',
    conversationId: 'c1',
  });
  // The fragile provider-timestamp CASE filter must be gone (it silently
  // excluded rows whose raw_payload.timestamp was missing/non-numeric).
  assert.doesNotMatch(capture[0].sql, /raw_payload->>'timestamp'/);
  // The robust created_at age bound is still present.
  assert.match(capture[0].sql, /created_at >= NOW\(\)/);
  // Only 4 params now (conversationId, userId, limit, maxAgeMs) — no $5.
  assert.equal(capture[0].params.length, 4);
});

test('loadPendingInboundMessages falls back to fallbackText without conversation/user', async () => {
  const rows = await loadPendingInboundMessages({
    database: fakeDb(0),
    fallbackMessageId: 'm1',
    fallbackText: 'مرحبا',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'مرحبا');
});
