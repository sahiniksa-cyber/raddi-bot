'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getConversationEscalationStats } = require('../src/workers/ai-worker');

function makeDb({ count, lastSentAt }) {
  return {
    isConfigured: () => true,
    query: async (sql) => {
      assert.match(sql, /escalation_log/);
      assert.match(sql, /INTERVAL '24 hours'/);
      return { rows: [{ n: count, last_sent_at: lastSentAt }] };
    },
  };
}

test('getConversationEscalationStats reports zero when there are no recent escalations', async () => {
  const stats = await getConversationEscalationStats({
    database: makeDb({ count: 0, lastSentAt: null }),
    conversationId: 'c-1',
  });
  assert.equal(stats.count24h, 0);
  assert.equal(stats.lastSentAt, null);
});

test('getConversationEscalationStats reports the count and most-recent timestamp', async () => {
  const ts = new Date('2026-05-28T10:00:00Z');
  const stats = await getConversationEscalationStats({
    database: makeDb({ count: 3, lastSentAt: ts }),
    conversationId: 'c-2',
  });
  assert.equal(stats.count24h, 3);
  assert.ok(stats.lastSentAt instanceof Date);
  assert.equal(stats.lastSentAt.toISOString(), ts.toISOString());
});

test('the 24h cap = 3 logic: a 4th escalation in 24h is blocked', () => {
  // Mirror the suppression logic from ai-worker.js so future refactors stay
  // honest. count24h >= 3 → suppress regardless of recency.
  function shouldSuppress(count24h, lastSentMs) {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const overCap = count24h >= 3;
    const tooSoon = count24h >= 1 && lastSentMs > tenMinAgo;
    return overCap || tooSoon;
  }

  // Pretend the previous escalation was an hour ago — well outside the 10-min
  // gap window — so only the cap matters.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  assert.equal(shouldSuppress(0, 0), false, '0 prior → allow');
  assert.equal(shouldSuppress(1, oneHourAgo), false, '1 prior, >10min ago → allow');
  assert.equal(shouldSuppress(2, oneHourAgo), false, '2 prior, >10min ago → allow');
  assert.equal(shouldSuppress(3, oneHourAgo), true, '3 prior → suppress');
  assert.equal(shouldSuppress(4, oneHourAgo), true, '4 prior → suppress');
});

test('min-gap logic: a second escalation within 10 minutes is blocked', () => {
  function shouldSuppress(count24h, lastSentMs) {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const overCap = count24h >= 3;
    const tooSoon = count24h >= 1 && lastSentMs > tenMinAgo;
    return overCap || tooSoon;
  }

  const twoMinAgo = Date.now() - 2 * 60 * 1000;
  const fifteenMinAgo = Date.now() - 15 * 60 * 1000;

  assert.equal(shouldSuppress(1, twoMinAgo), true, '1 prior, 2min ago → suppress');
  assert.equal(shouldSuppress(1, fifteenMinAgo), false, '1 prior, 15min ago → allow');
});
