'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConversationEscalationMuted } = require('../src/workers/ai-worker');

test('isConversationEscalationMuted returns true when escalated_until > NOW()', async () => {
  const db = {
    isConfigured: () => true,
    query: async (sql, params) => {
      assert.match(sql, /escalated_until/);
      assert.match(sql, /escalated_until > NOW\(\)/);
      assert.deepEqual(params, ['conv-muted', 'user-1']);
      return { rows: [{ escalated_until: new Date(Date.now() + 30 * 60 * 1000) }] };
    },
  };
  const muted = await isConversationEscalationMuted({
    database: db,
    userId: 'user-1',
    conversationId: 'conv-muted',
  });
  assert.equal(muted, true);
});

test('isConversationEscalationMuted returns false when no active window', async () => {
  const db = {
    isConfigured: () => true,
    query: async () => ({ rows: [] }),
  };
  const muted = await isConversationEscalationMuted({
    database: db,
    userId: 'user-1',
    conversationId: 'conv-fresh',
  });
  assert.equal(muted, false);
});

test('isConversationEscalationMuted fails open if the column is missing (pre-migration)', async () => {
  const db = {
    isConfigured: () => true,
    query: async () => {
      const err = new Error('column "escalated_until" does not exist');
      err.code = '42703';
      throw err;
    },
  };
  const muted = await isConversationEscalationMuted({
    database: db,
    userId: 'user-1',
    conversationId: 'conv-x',
  });
  assert.equal(muted, false, 'must fail open so message processing continues');
});

test('isConversationEscalationMuted returns false when DB is not configured', async () => {
  const db = { isConfigured: () => false, query: async () => { throw new Error('nope'); } };
  const muted = await isConversationEscalationMuted({
    database: db,
    userId: 'user-1',
    conversationId: 'c',
  });
  assert.equal(muted, false);
});

test('isConversationEscalationMuted returns false when conversationId missing', async () => {
  const muted = await isConversationEscalationMuted({
    database: { isConfigured: () => true, query: async () => ({ rows: [{ escalated_until: new Date() }] }) },
    userId: 'user-1',
    conversationId: null,
  });
  assert.equal(muted, false);
});
