'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We test the two exported functions:
//   copyMerchantConfig(db, srcUserId, dstUserId)  — pure, takes a fake db
//   copyMerchantConfigByEmail(srcEmail, dstEmail)  — resolves emails then calls it
//
// The fake db mimics the real src/db/client contract: it exposes `query` and a
// `transaction(fn)` that hands `fn` a client. To let the test prove a real
// transaction is used, the fake transaction issues BEGIN/COMMIT (and ROLLBACK
// on throw) on the SAME client object the service uses, exactly like the real
// db.transaction in src/db/client.js.

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// Build a fake db over an in-memory store. `users` maps email→id. The other
// arrays hold rows keyed by user_id.
function makeFakeDb(seed = {}) {
  const store = {
    users: seed.users || [], // { id, email }
    bot_configs: seed.bot_configs || [], // { user_id, config, source }
    customer_api_keys: seed.customer_api_keys || [], // { user_id, provider, api_key_encrypted, api_key_iv, api_key_tag, api_key_format, updated_by }
    learned_replies: seed.learned_replies || [], // { user_id, question, answer, normalized_question, ... }
  };

  const calls = []; // ordered SQL verbs seen on the client (BEGIN/COMMIT/ROLLBACK/...)

  function dispatch(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();

    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    }

    // Resolve user id by email
    if (/^SELECT id FROM users WHERE LOWER\(email\) = \$1/i.test(text)) {
      const target = normEmail(params[0]);
      const u = store.users.find(r => normEmail(r.email) === target);
      return { rows: u ? [{ id: u.id }] : [], rowCount: u ? 1 : 0 };
    }

    // Read source bot_configs row
    if (/^SELECT config(, source)? FROM bot_configs WHERE user_id = \$1/i.test(text)) {
      const row = store.bot_configs.find(r => r.user_id === params[0]);
      return { rows: row ? [{ config: row.config, source: row.source || 'app' }] : [], rowCount: row ? 1 : 0 };
    }

    // UPSERT dst bot_configs
    if (/^INSERT INTO bot_configs/i.test(text)) {
      const [userId, configJson] = params;
      calls.push('UPSERT bot_configs');
      const config = JSON.parse(configJson);
      const existing = store.bot_configs.find(r => r.user_id === userId);
      if (existing) {
        existing.config = config;
      } else {
        store.bot_configs.push({ user_id: userId, config, source: 'admin-copy' });
      }
      return { rows: [], rowCount: 1 };
    }

    // Read source customer_api_keys rows
    if (/^SELECT .* FROM customer_api_keys WHERE user_id = \$1/i.test(text)) {
      const out = store.customer_api_keys.filter(r => r.user_id === params[0]);
      return { rows: out.map(r => ({ ...r })), rowCount: out.length };
    }

    // UPSERT dst customer_api_keys
    if (/^INSERT INTO customer_api_keys/i.test(text)) {
      const [userId, provider, enc, iv, tag, fmt, updatedBy] = params;
      calls.push('UPSERT customer_api_keys');
      const existing = store.customer_api_keys.find(r => r.user_id === userId && r.provider === provider);
      const next = {
        user_id: userId, provider,
        api_key_encrypted: enc, api_key_iv: iv, api_key_tag: tag,
        api_key_format: fmt, updated_by: updatedBy,
      };
      if (existing) Object.assign(existing, next);
      else store.customer_api_keys.push(next);
      return { rows: [], rowCount: 1 };
    }

    // Read source learned_replies rows
    if (/^SELECT .* FROM learned_replies WHERE user_id = \$1/i.test(text)) {
      const out = store.learned_replies.filter(r => r.user_id === params[0]);
      return { rows: out.map(r => ({ ...r })), rowCount: out.length };
    }

    // INSERT dst learned_replies (UPSERT on (user_id, normalized_question))
    if (/^INSERT INTO learned_replies/i.test(text)) {
      const [userId, question, answer, normalized, status] = params;
      calls.push('INSERT learned_replies');
      const existing = store.learned_replies.find(
        r => r.user_id === userId && r.normalized_question === normalized,
      );
      const next = { user_id: userId, question, answer, normalized_question: normalized, status: status || 'active' };
      if (existing) Object.assign(existing, next);
      else store.learned_replies.push(next);
      return { rows: [], rowCount: 1 };
    }

    throw new Error('Unexpected query in test stub: ' + text);
  }

  const client = { query: async (sql, params) => dispatch(sql, params) };

  const db = {
    query: async (sql, params) => dispatch(sql, params),
    // Mirror the real db.transaction so BEGIN/COMMIT/ROLLBACK land on `client`.
    transaction: async (fn) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    },
    isConfigured: () => true,
  };

  return { db, store, calls, client };
}

const { copyMerchantConfig } = require('../src/services/admin/copy-merchant-config');

test('copies bot_configs.config to dst via UPSERT when dst has no row', async () => {
  const { db, store, calls } = makeFakeDb({
    bot_configs: [{ user_id: 'src', config: { model: 'gpt-4o', replyStyle: 'warm' }, source: 'app' }],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  const dst = store.bot_configs.find(r => r.user_id === 'dst');
  assert.ok(dst, 'dst config row created');
  assert.deepEqual(dst.config, { model: 'gpt-4o', replyStyle: 'warm' });
  assert.ok(calls.includes('UPSERT bot_configs'));
});

test('copies bot_configs.config via UPSERT when dst ALREADY has a row (overwrites)', async () => {
  const { db, store } = makeFakeDb({
    bot_configs: [
      { user_id: 'src', config: { model: 'claude', products: [1, 2] }, source: 'app' },
      { user_id: 'dst', config: { model: 'OLD', products: [] }, source: 'app' },
    ],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  const dst = store.bot_configs.find(r => r.user_id === 'dst');
  assert.deepEqual(dst.config, { model: 'claude', products: [1, 2] });
});

test('copied config carries NO api keys', async () => {
  const { db, store } = makeFakeDb({
    bot_configs: [{
      user_id: 'src',
      // A config that (defensively) still has key fields — copy must strip them.
      config: { model: 'gpt-4o', openaiApiKey: 'sk-LEAK', anthropicApiKey: 'x', knowledge: 'hi' },
      source: 'app',
    }],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  const dst = store.bot_configs.find(r => r.user_id === 'dst');
  assert.equal(dst.config.openaiApiKey, undefined);
  assert.equal(dst.config.anthropicApiKey, undefined);
  assert.equal(dst.config.googleApiKey, undefined);
  assert.equal(dst.config.openrouterApiKey, undefined);
  assert.equal(dst.config.model, 'gpt-4o');
  assert.equal(dst.config.knowledge, 'hi');
});

test('copies customer_api_keys rows per provider', async () => {
  const { db, store } = makeFakeDb({
    bot_configs: [{ user_id: 'src', config: {}, source: 'app' }],
    customer_api_keys: [
      { user_id: 'src', provider: 'openai', api_key_encrypted: 'enc1', api_key_iv: 'iv1', api_key_tag: 't1', api_key_format: 'aes-256-gcm', updated_by: 'admin' },
      { user_id: 'src', provider: 'anthropic', api_key_encrypted: 'enc2', api_key_iv: 'iv2', api_key_tag: 't2', api_key_format: 'aes-256-gcm', updated_by: 'admin' },
    ],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  const dstKeys = store.customer_api_keys.filter(r => r.user_id === 'dst');
  assert.equal(dstKeys.length, 2);
  const openai = dstKeys.find(k => k.provider === 'openai');
  assert.equal(openai.api_key_encrypted, 'enc1');
  assert.equal(openai.api_key_iv, 'iv1');
  assert.ok(dstKeys.find(k => k.provider === 'anthropic'));
});

test('copies learned_replies rows', async () => {
  const { db, store } = makeFakeDb({
    bot_configs: [{ user_id: 'src', config: {}, source: 'app' }],
    learned_replies: [
      { user_id: 'src', question: 'Q1', answer: 'A1', normalized_question: 'q1', status: 'active' },
      { user_id: 'src', question: 'Q2', answer: 'A2', normalized_question: 'q2', status: 'active' },
    ],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  const dst = store.learned_replies.filter(r => r.user_id === 'dst');
  assert.equal(dst.length, 2);
  assert.deepEqual(dst.map(r => r.normalized_question).sort(), ['q1', 'q2']);
});

test('all writes happen inside ONE transaction (BEGIN ... COMMIT)', async () => {
  const { db, calls } = makeFakeDb({
    bot_configs: [{ user_id: 'src', config: { model: 'x' }, source: 'app' }],
    customer_api_keys: [{ user_id: 'src', provider: 'openai', api_key_encrypted: 'e' }],
    learned_replies: [{ user_id: 'src', question: 'q', answer: 'a', normalized_question: 'q' }],
  });
  await copyMerchantConfig(db, 'src', 'dst');
  assert.equal(calls[0], 'BEGIN', 'first verb is BEGIN');
  assert.equal(calls[calls.length - 1], 'COMMIT', 'last verb is COMMIT');
  assert.ok(!calls.includes('ROLLBACK'));
  // All writes occurred between BEGIN and COMMIT.
  const begin = calls.indexOf('BEGIN');
  const commit = calls.indexOf('COMMIT');
  assert.ok(calls.indexOf('UPSERT bot_configs') > begin && calls.indexOf('UPSERT bot_configs') < commit);
});

test('ROLLBACK on error (e.g. missing source config)', async () => {
  // src has NO bot_configs row → service should treat that as an error and roll back.
  const { db, calls } = makeFakeDb({ bot_configs: [] });
  await assert.rejects(() => copyMerchantConfig(db, 'src', 'dst'), /source|config|not found/i);
  assert.ok(calls.includes('BEGIN'));
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
});

test('errors when src === dst', async () => {
  const { db } = makeFakeDb({ bot_configs: [{ user_id: 'same', config: {} }] });
  await assert.rejects(() => copyMerchantConfig(db, 'same', 'same'), /same|differ|identical/i);
});

test('errors when src or dst userId missing', async () => {
  const { db } = makeFakeDb({});
  await assert.rejects(() => copyMerchantConfig(db, '', 'dst'), /required|missing/i);
  await assert.rejects(() => copyMerchantConfig(db, 'src', ''), /required|missing/i);
});

// ── copyMerchantConfigByEmail: resolves emails → ids, then delegates ──
test('copyMerchantConfigByEmail resolves emails and copies', async () => {
  const { db, store } = makeFakeDb({
    users: [
      { id: 'u-old', email: 'old@shop.com' },
      { id: 'u-new', email: 'NEW@shop.com' },
    ],
    bot_configs: [{ user_id: 'u-old', config: { model: 'gpt-4o' }, source: 'app' }],
  });
  // Inject the fake db into the module by stubbing src/db/client in cache.
  const dbClientPath = require.resolve('../src/db/client');
  const prev = require.cache[dbClientPath];
  require.cache[dbClientPath] = { id: dbClientPath, filename: dbClientPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../src/services/admin/copy-merchant-config')];
  const { copyMerchantConfigByEmail } = require('../src/services/admin/copy-merchant-config');
  try {
    const result = await copyMerchantConfigByEmail('Old@Shop.com', 'new@shop.com');
    assert.equal(result.srcUserId, 'u-old');
    assert.equal(result.dstUserId, 'u-new');
    const dst = store.bot_configs.find(r => r.user_id === 'u-new');
    assert.deepEqual(dst.config, { model: 'gpt-4o' });
  } finally {
    if (prev) require.cache[dbClientPath] = prev; else delete require.cache[dbClientPath];
    delete require.cache[require.resolve('../src/services/admin/copy-merchant-config')];
  }
});

test('copyMerchantConfigByEmail errors when an email is unknown', async () => {
  const { db } = makeFakeDb({
    users: [{ id: 'u-old', email: 'old@shop.com' }],
    bot_configs: [{ user_id: 'u-old', config: {} }],
  });
  const dbClientPath = require.resolve('../src/db/client');
  const prev = require.cache[dbClientPath];
  require.cache[dbClientPath] = { id: dbClientPath, filename: dbClientPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../src/services/admin/copy-merchant-config')];
  const { copyMerchantConfigByEmail } = require('../src/services/admin/copy-merchant-config');
  try {
    await assert.rejects(
      () => copyMerchantConfigByEmail('old@shop.com', 'ghost@shop.com'),
      /not found|الوجهة|المصدر|غير موجود/i,
    );
  } finally {
    if (prev) require.cache[dbClientPath] = prev; else delete require.cache[dbClientPath];
    delete require.cache[require.resolve('../src/services/admin/copy-merchant-config')];
  }
});
