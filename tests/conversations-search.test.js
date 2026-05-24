'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConversationsController } = require('../src/controllers/conversations.controller');

function makeDb() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0, ongoing: 0, finished: 0 }] };
      return { rows: [] };
    },
  };
}

test('list passes ?q= into ILIKE WHERE clauses on sender and message content', async () => {
  const database = makeDb();
  const ctl = createConversationsController({ database });
  const req = { session: { userId: 'u1' }, query: { q: '5234' } };
  const res = { json: () => {} };
  await ctl.list(req, res);

  const listQuery = database.queries.find(q => /FROM conversations c/.test(q.sql) && /LEFT JOIN LATERAL/.test(q.sql));
  assert.ok(listQuery, 'list query must run');
  assert.match(listQuery.sql, /c\.sender ILIKE/);
  assert.match(listQuery.sql, /m2\.content ILIKE/);
  assert.ok(listQuery.params.includes('%5234%'), 'params must include wildcard-wrapped query');
});

test('list omits ILIKE branch when q is empty', async () => {
  const database = makeDb();
  const ctl = createConversationsController({ database });
  const req = { session: { userId: 'u1' }, query: { q: '' } };
  const res = { json: () => {} };
  await ctl.list(req, res);

  const listQuery = database.queries.find(q => /FROM conversations c/.test(q.sql) && /LEFT JOIN LATERAL/.test(q.sql));
  assert.doesNotMatch(listQuery.sql, /ILIKE/);
});
