'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPendingEscalation } = require('../src/workers/ai-worker');
const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

function createClient(config) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...config },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {} },
  );
}

function makeDb(rows) {
  return {
    isConfigured: () => true,
    query: async (sql) => {
      assert.match(sql, /escalation_threads/);
      assert.match(sql, /resolved_at IS NULL/);
      return { rows };
    },
  };
}

// ── getPendingEscalation (state query) ────────────────────────────────
test('getPendingEscalation reports pending when an unresolved escalation thread exists', async () => {
  const r = await getPendingEscalation({
    database: makeDb([{ created_at: new Date('2026-06-27T09:00:00Z') }]),
    userId: 'u-1',
    conversationId: 'c-1',
  });
  assert.equal(r.pending, true);
});

test('getPendingEscalation reports not pending when there is no unresolved thread', async () => {
  const r = await getPendingEscalation({ database: makeDb([]), userId: 'u-1', conversationId: 'c-1' });
  assert.equal(r.pending, false);
});

test('getPendingEscalation ignores an unresolved thread after a direct owner reply', async () => {
  let queryText = '';
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      queryText = sql;
      return { rows: [] };
    },
  };

  const r = await getPendingEscalation({
    database,
    userId: 'u-1',
    conversationId: 'c-1',
  });

  assert.equal(r.pending, false);
  assert.match(queryText, /NOT EXISTS/);
  assert.match(queryText, /messages/);
  assert.match(queryText, /sent_by_human/);
  assert.match(queryText, /created_at > escalation_threads\.created_at/);
});

test('getPendingEscalation is safe when the database is not configured', async () => {
  const r = await getPendingEscalation({
    database: { isConfigured: () => false },
    userId: 'u-1',
    conversationId: 'c-1',
  });
  assert.equal(r.pending, false);
});

// ── prompt block (the bot is told the request is already registered) ───
test('prompt tells the bot the request is already registered when an escalation is pending', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt(
    [{ role: 'user', content: 'ايش صار بخصوص المشكلة؟' }],
    { escalationPending: true },
  );
  assert.match(prompt, /قيد المتابعة/);
  assert.match(prompt, /لا تسجّل الطلب من جديد/);
});

test('no already-registered block when there is no pending escalation', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'كم السعر؟' }], {});
  assert.doesNotMatch(prompt, /قيد المتابعة/);
});

test('the pending-escalation block also appears in the long-custom-instructions path', () => {
  const ai = createClient({ botInstructions: 'تعليمات المالك '.repeat(40) });
  const prompt = ai.buildSystemPrompt([], { escalationPending: true });
  assert.match(prompt, /قيد المتابعة/);
});
