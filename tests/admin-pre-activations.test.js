'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub the db/client module before requiring the service. The service uses
// db.query and db.transaction; we swap both with in-memory implementations
// backed by a single array of rows so we can exercise the SQL paths.
const dbClientPath = require.resolve('../src/db/client');

let nextId = 1;
let rows = [];

function resetState() {
  nextId = 1;
  rows = [];
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// Crude SQL dispatch — recognises only the queries this service issues.
function dispatch(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').trim();

  // INSERT new row (used inside createPreActivation transaction)
  if (text.startsWith('INSERT INTO pre_activations')) {
    const [email, duration_days, note, created_by_admin] = params;
    const row = {
      id: nextId++,
      email,
      duration_days,
      note: note || null,
      created_by_admin: created_by_admin || null,
      created_at: new Date(),
      used_at: null,
      used_by_user_id: null,
    };
    rows.push(row);
    return { rows: [row], rowCount: 1 };
  }

  // DELETE unused by lower(email)  (createPreActivation cleanup)
  if (text.startsWith('DELETE FROM pre_activations WHERE LOWER(email)')) {
    const target = String(params[0]);
    const before = rows.length;
    rows = rows.filter(r => !(normEmail(r.email) === target && r.used_at == null));
    return { rows: [], rowCount: before - rows.length };
  }

  // DELETE by id (deletePreActivation)
  if (text.startsWith('DELETE FROM pre_activations WHERE id =')) {
    const id = params[0];
    const before = rows.length;
    rows = rows.filter(r => !(r.id === id && r.used_at == null));
    return { rows: [], rowCount: before - rows.length };
  }

  // SELECT list
  if (text.startsWith('SELECT id, email, duration_days, note, created_by_admin')) {
    const includeUsed = !text.includes('WHERE used_at IS NULL');
    let out = rows.slice();
    if (!includeUsed) out = out.filter(r => r.used_at == null);
    out.sort((a, b) => b.created_at - a.created_at);
    return { rows: out.slice(0, 200), rowCount: out.length };
  }

  // UPDATE ... consume
  if (text.startsWith('UPDATE pre_activations SET used_at = NOW()')) {
    const target = normEmail(params[0]);
    const userId = params[1];
    const candidates = rows
      .filter(r => normEmail(r.email) === target && r.used_at == null)
      .sort((a, b) => b.created_at - a.created_at);
    const pick = candidates[0];
    if (!pick) return { rows: [], rowCount: 0 };
    pick.used_at = new Date();
    pick.used_by_user_id = userId;
    return { rows: [{ id: pick.id, duration_days: pick.duration_days }], rowCount: 1 };
  }

  throw new Error('Unexpected query in test stub: ' + text);
}

const stubClient = {
  query: async (sql, params) => dispatch(sql, params),
};

const stubDb = {
  query: async (sql, params) => dispatch(sql, params),
  transaction: async (fn) => fn(stubClient),
  isConfigured: () => true,
};

// Inject stub into the module cache so the service picks it up on require.
require.cache[dbClientPath] = {
  id: dbClientPath,
  filename: dbClientPath,
  loaded: true,
  exports: stubDb,
};

const {
  createPreActivation,
  listPreActivations,
  deletePreActivation,
  consumePreActivationForUser,
  normalizeEmail,
} = require('../src/services/admin/pre-activations');

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeEmail(null), '');
});

test('createPreActivation rejects missing email', async () => {
  resetState();
  await assert.rejects(
    () => createPreActivation({ email: '', durationDays: 7 }),
    /email required/,
  );
});

test('createPreActivation rejects non-positive durationDays', async () => {
  resetState();
  await assert.rejects(
    () => createPreActivation({ email: 'a@b.com', durationDays: 0 }),
    /durationDays/,
  );
  await assert.rejects(
    () => createPreActivation({ email: 'a@b.com', durationDays: -5 }),
    /durationDays/,
  );
  await assert.rejects(
    () => createPreActivation({ email: 'a@b.com', durationDays: 'abc' }),
    /durationDays/,
  );
});

test('createPreActivation stores a normalized email and returns the row', async () => {
  resetState();
  const row = await createPreActivation({
    email: '  Foo@Example.COM  ',
    durationDays: 14,
    note: 'VIP',
    createdByAdmin: 'admin-1',
  });
  assert.equal(row.email, 'foo@example.com');
  assert.equal(row.duration_days, 14);
  assert.equal(row.note, 'VIP');
  assert.equal(row.created_by_admin, 'admin-1');
});

test('createPreActivation replaces any pending row for the same email', async () => {
  resetState();
  await createPreActivation({ email: 'dup@x.com', durationDays: 3 });
  await createPreActivation({ email: 'DUP@x.com', durationDays: 30, note: 'newer' });
  const pending = await listPreActivations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].duration_days, 30);
  assert.equal(pending[0].note, 'newer');
});

test('listPreActivations hides used rows by default and shows them when requested', async () => {
  resetState();
  await createPreActivation({ email: 'used@x.com', durationDays: 7 });
  await createPreActivation({ email: 'pending@x.com', durationDays: 14 });
  // Consume the first one
  const consumed = await consumePreActivationForUser({ email: 'used@x.com', userId: 'u1' });
  assert.ok(consumed);
  const pending = await listPreActivations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].email, 'pending@x.com');
  const all = await listPreActivations({ includeUsed: true });
  assert.equal(all.length, 2);
});

test('consumePreActivationForUser marks used_at and returns duration', async () => {
  resetState();
  await createPreActivation({ email: 'one@x.com', durationDays: 30 });
  const result = await consumePreActivationForUser({ email: 'one@x.com', userId: 'u1' });
  assert.ok(result);
  assert.equal(result.durationDays, 30);
  // The row is now marked used
  const all = await listPreActivations({ includeUsed: true });
  assert.equal(all.length, 1);
  assert.ok(all[0].used_at);
  assert.equal(all[0].used_by_user_id, 'u1');
});

test('consumePreActivationForUser returns null on second call for same email', async () => {
  resetState();
  await createPreActivation({ email: 'twice@x.com', durationDays: 7 });
  const first = await consumePreActivationForUser({ email: 'twice@x.com', userId: 'u1' });
  assert.ok(first);
  const second = await consumePreActivationForUser({ email: 'twice@x.com', userId: 'u2' });
  assert.equal(second, null);
});

test('consumePreActivationForUser is case-insensitive on email', async () => {
  resetState();
  await createPreActivation({ email: 'Mixed@Case.COM', durationDays: 14 });
  const result = await consumePreActivationForUser({ email: 'mixed@case.com', userId: 'u9' });
  assert.ok(result);
  assert.equal(result.durationDays, 14);
});

test('consumePreActivationForUser returns null for unknown email', async () => {
  resetState();
  const result = await consumePreActivationForUser({ email: 'nobody@nowhere.com', userId: 'u1' });
  assert.equal(result, null);
});

test('deletePreActivation removes only unused rows', async () => {
  resetState();
  const row = await createPreActivation({ email: 'del@x.com', durationDays: 7 });
  const r1 = await deletePreActivation({ id: row.id });
  assert.equal(r1.deleted, true);
  const pending = await listPreActivations();
  assert.equal(pending.length, 0);
});
