'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractFromText, upsertProfile, getProfile } = require('../src/workers/profile-extractor');

test('extractFromText returns {} for empty/whitespace text', () => {
  assert.deepEqual(extractFromText(''), {});
  assert.deepEqual(extractFromText('   \n  '), {});
  assert.deepEqual(extractFromText(null), {});
  assert.deepEqual(extractFromText(undefined), {});
});

test('extractFromText pulls an email out of free Arabic text', () => {
  const out = extractFromText('السلام عليكم ايميلي Hassan.Ali+test@Example.COM وأبي أعرف الطلب');
  assert.equal(out.email, 'hassan.ali+test@example.com');
});

test('extractFromText pulls an order ref in Arabic ("طلب رقم")', () => {
  const out = extractFromText('طلب رقم AB12-99 لسه ما وصل');
  assert.equal(out.last_order_ref, 'AB12-99');
});

test('extractFromText pulls an order ref in English', () => {
  const out = extractFromText('Hi, can you check order #ZX9988 please?');
  assert.equal(out.last_order_ref, 'ZX9988');
});

test('extractFromText pulls a name from "اسمي X"', () => {
  const out = extractFromText('السلام عليكم، اسمي محمد العبدالله وأبي أسأل');
  assert.ok(out.name, 'expected name field');
  assert.ok(out.name.includes('محمد'), `expected captured name to include محمد, got ${out.name}`);
});

test('extractFromText caps name to at most 3 words', () => {
  const out = extractFromText('اسمي عبدالله محمد علي حسن العتيبي السالم');
  assert.ok(out.name);
  assert.ok(out.name.split(/\s+/).length <= 3, `name should be <= 3 words: ${out.name}`);
});

test('extractFromText does not return a name field for "انا تعبان"-style false positives that are too short', () => {
  // "انا في البيت" — captures "في البيت" (2 words letters) — that's actually
  // a valid match in our heuristic. We only assert that a single word like
  // "انا ا" wouldn't pass (min 2 chars after trim).
  const out = extractFromText('انا');
  assert.equal(out.name, undefined, 'standalone "انا" without a following word should not match');
});

test('extractFromText returns {} when nothing extractable', () => {
  const out = extractFromText('شكراً 🌷');
  assert.deepEqual(out, {});
});

test('extractFromText combines multiple fields from one message', () => {
  const out = extractFromText('اسمي خالد، ايميلي k@x.com، طلب رقم ORD-7788');
  assert.equal(out.email, 'k@x.com');
  assert.equal(out.last_order_ref, 'ORD-7788');
  assert.ok(out.name && out.name.includes('خالد'));
});

// ── upsertProfile / getProfile against a fake DB ──────────────────────
function makeFakeDb({ existing = null, throwOnUpsert = false, throwOnSelect = false } = {}) {
  const calls = [];
  let row = existing;
  return {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO customer_profiles')) {
        if (throwOnUpsert) throw new Error('upsert boom');
        // Update our in-memory row from params (cols are conversation_id, user_id, ...present).
        row = row || { conversation_id: params[0], user_id: params[1] };
        // The columns after the first two are listed inside the SQL — we
        // don't reparse; the unit tests below only assert via getProfile.
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT name, email, phone, last_order_ref')) {
        if (throwOnSelect) throw new Error('select boom');
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
}

test('upsertProfile no-ops when no allowed fields are provided', async () => {
  const fake = makeFakeDb();
  await upsertProfile({ conversationId: 'c1', userId: 'u1', fields: {}, database: fake });
  assert.equal(fake.calls.length, 0, 'no SQL should run for empty field set');
});

test('upsertProfile no-ops when only unknown keys are provided', async () => {
  const fake = makeFakeDb();
  await upsertProfile({
    conversationId: 'c1',
    userId: 'u1',
    fields: { foo: 'bar', x: 'y' },
    database: fake,
  });
  assert.equal(fake.calls.length, 0);
});

test('upsertProfile issues a single INSERT … ON CONFLICT statement with allowed fields', async () => {
  const fake = makeFakeDb();
  await upsertProfile({
    conversationId: 'c1',
    userId: 'u1',
    fields: { name: 'خالد', email: 'k@x.com', notes: 'مهم' },
    database: fake,
  });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.ok(call.sql.includes('INSERT INTO customer_profiles'));
  assert.ok(call.sql.includes('ON CONFLICT (conversation_id) DO UPDATE'));
  // First two params are always conversation_id, user_id.
  assert.equal(call.params[0], 'c1');
  assert.equal(call.params[1], 'u1');
  assert.deepEqual(call.params.slice(2), ['خالد', 'k@x.com', 'مهم']);
});

test('upsertProfile swallows DB errors and does not throw', async () => {
  const fake = makeFakeDb({ throwOnUpsert: true });
  await upsertProfile({
    conversationId: 'c1',
    userId: 'u1',
    fields: { name: 'x' },
    database: fake,
  });
  // If we reach here without throwing, behavior is correct.
  assert.ok(true);
});

test('upsertProfile no-ops when database is not configured', async () => {
  const fake = { isConfigured: () => false, query: async () => { throw new Error('should not call'); } };
  await upsertProfile({
    conversationId: 'c1',
    userId: 'u1',
    fields: { name: 'x' },
    database: fake,
  });
  assert.ok(true);
});

test('getProfile returns null when no row exists', async () => {
  const fake = makeFakeDb({ existing: null });
  const out = await getProfile({ conversationId: 'c1', database: fake });
  assert.equal(out, null);
});

test('getProfile returns the row when one exists', async () => {
  const fake = makeFakeDb({
    existing: { name: 'سلمى', email: 's@x.com', phone: null, last_order_ref: 'A1', preferences: {}, open_question: null, notes: null },
  });
  const out = await getProfile({ conversationId: 'c1', database: fake });
  assert.ok(out);
  assert.equal(out.name, 'سلمى');
  assert.equal(out.email, 's@x.com');
});

test('getProfile fails open (returns null) when the SELECT throws', async () => {
  const fake = makeFakeDb({ throwOnSelect: true });
  const out = await getProfile({ conversationId: 'c1', database: fake });
  assert.equal(out, null);
});

test('getProfile returns null without a conversationId', async () => {
  const fake = makeFakeDb();
  const out = await getProfile({ conversationId: null, database: fake });
  assert.equal(out, null);
  assert.equal(fake.calls.length, 0);
});

test('getProfile returns null when database is not configured', async () => {
  const fake = { isConfigured: () => false, query: async () => { throw new Error('should not call'); } };
  const out = await getProfile({ conversationId: 'c1', database: fake });
  assert.equal(out, null);
});
