'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { createInstagramRoutes } = require('../src/routes/instagram.routes');

function makeApp(env, extraDeps = {}) {
  const app = express();
  // Attach a fake session so requireAuth-dependent routes have a userId.
  app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });
  // Mirror the production server: JSON body parsing for every route EXCEPT the
  // webhook, which needs the raw body for HMAC (handled by its own express.raw).
  app.use((req, res, next) => {
    if (req.path === '/instagram/webhook') return next();
    return express.json()(req, res, next);
  });
  app.use(createInstagramRoutes({ env, ...extraDeps }));
  return app;
}

function req(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
      const r = http.request({
        hostname: '127.0.0.1', port, method, path,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      r.on('error', (err) => { server.close(); reject(err); });
      if (data) r.write(data);
      r.end();
    });
  });
}

test('GET webhook echoes challenge when verify token matches', async () => {
  const app = makeApp({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'VT' });
  const res = await req(app, 'GET', '/instagram/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=12345');
  assert.equal(res.status, 200);
  assert.equal(res.body, '12345');
});

test('GET webhook 403 on wrong verify token', async () => {
  const app = makeApp({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'VT' });
  const res = await req(app, 'GET', '/instagram/webhook?hub.verify_token=WRONG&hub.challenge=x');
  assert.equal(res.status, 403);
});

test('POST webhook rejects bad signature (401) and does not ingest', async () => {
  let ingested = 0;
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: 'S' },
    {
      ingest: { extractMessages: () => [{ igAccountId: 'A', participantId: 'C', text: 'hi', echo: false }], ingestWebhookEntry: async () => { ingested++; } },
      accounts: { findUserIdByIgAccount: async () => 'u1' },
    },
  );
  const res = await req(app, 'POST', '/instagram/webhook', {
    headers: { 'X-Hub-Signature-256': 'sha256=deadbeef' },
    body: { object: 'instagram' },
  });
  assert.equal(res.status, 401);
  assert.equal(ingested, 0);
});

test('POST webhook 200 + ingests on good signature', async () => {
  let ingested = 0;
  const secret = 'S';
  const payload = { object: 'instagram', entry: [{ id: 'A', messaging: [{ sender: { id: 'C' }, message: { mid: 'm1', text: 'hi' } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: secret },
    {
      ingest: {
        extractMessages: () => [{ igAccountId: 'A', participantId: 'C', mid: 'm1', text: 'hi', echo: false }],
        ingestWebhookEntry: async () => { ingested++; },
      },
      accounts: { findUserIdByIgAccount: async () => 'u1' },
    },
  );
  const res = await req(app, 'POST', '/instagram/webhook', { headers: { 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(res.status, 200);
  // ingest happens after the 200 is sent; give the microtask queue a tick
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ingested, 1);
});

test('POST webhook self-heals to the sole connected account when the id does not match', async () => {
  let ingested = 0; let healed = null;
  const secret = 'S';
  const payload = { object: 'instagram', entry: [{ id: 'WEBHOOK_ID_999', messaging: [{ sender: { id: 'C' }, message: { mid: 'm2', text: 'hi' } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: secret },
    {
      ingest: {
        extractMessages: () => [{ igAccountId: 'WEBHOOK_ID_999', participantId: 'C', mid: 'm2', text: 'hi', echo: false }],
        ingestWebhookEntry: async () => { ingested++; },
      },
      accounts: {
        findUserIdByIgAccount: async () => null,                       // stored id doesn't match
        listConnectedAccounts: async () => [{ user_id: 'u1', ig_user_id: 'OLD_ID' }], // exactly one merchant
        setIgUserId: async (uid, id) => { healed = { uid, id }; },
      },
    },
  );
  const res = await req(app, 'POST', '/instagram/webhook', { headers: { 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ingested, 1);                                          // message routed despite the mismatch
  assert.deepEqual(healed, { uid: 'u1', id: 'WEBHOOK_ID_999' });      // stored id healed to what Meta sends
});

test('POST webhook drops the message (no ingest) when the account is ambiguous', async () => {
  let ingested = 0;
  const secret = 'S';
  const payload = { object: 'instagram', entry: [{ id: 'X', messaging: [{ sender: { id: 'C' }, message: { mid: 'm3', text: 'hi' } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: secret },
    {
      ingest: { extractMessages: () => [{ igAccountId: 'X', participantId: 'C', mid: 'm3', text: 'hi', echo: false }], ingestWebhookEntry: async () => { ingested++; } },
      accounts: { findUserIdByIgAccount: async () => null, listConnectedAccounts: async () => [{ user_id: 'a' }, { user_id: 'b' }] },
    },
  );
  const res = await req(app, 'POST', '/instagram/webhook', { headers: { 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ingested, 0);   // >1 connected → no safe unique target → dropped (logged)
});

test('API routes return 503 when INSTAGRAM_ENABLED is not true', async () => {
  const app = makeApp({ INSTAGRAM_ENABLED: 'false' });
  const res = await req(app, 'GET', '/api/instagram/status');
  assert.equal(res.status, 503);
  assert.match(res.body, /instagram_disabled/);
});

test('connect redirects to the authorize URL when enabled', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    { oauth: { buildAuthorizeUrl: (state) => `https://www.instagram.com/oauth/authorize?state=${state}` } },
  );
  const res = await req(app, 'GET', '/api/instagram/connect');
  assert.equal(res.status, 302);
});

// ── Sandbox test-chat ───────────────────────────────────────────────────────

test('test-chat returns the generated reply and grows the sandbox memory', async () => {
  const seen = [];
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    { generateInstagramTestReply: async (userId, history) => { seen.push(history.map((m) => m.role)); return { reply: 'أهلاً بك 👋', aiEnabled: true }; } },
  );
  const r1 = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'السلام عليكم', sessionId: 's1' } });
  assert.equal(r1.status, 200);
  const b1 = JSON.parse(r1.body);
  assert.equal(b1.reply, 'أهلاً بك 👋');
  assert.equal(b1.historyLength, 2);            // user + assistant retained

  // Second turn on the SAME session must carry the prior turns into the generator.
  const r2 = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'كم السعر؟', sessionId: 's1' } });
  const b2 = JSON.parse(r2.body);
  assert.equal(b2.historyLength, 4);
  assert.deepEqual(seen[1], ['user', 'assistant', 'user']); // accumulated thread
});

test('test-chat rejects an empty message with 400', async () => {
  const app = makeApp({ INSTAGRAM_ENABLED: 'true' }, { generateInstagramTestReply: async () => ({ reply: 'x' }) });
  const res = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: '   ', sessionId: 's1' } });
  assert.equal(res.status, 400);
});

test('test-chat reset clears the session thread', async () => {
  let calls = 0;
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    { generateInstagramTestReply: async () => { calls++; return { reply: 'r', aiEnabled: true }; } },
  );
  await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'hi', sessionId: 's1' } });
  const reset = await req(app, 'POST', '/api/instagram/test-chat', { body: { reset: true, sessionId: 's1' } });
  assert.equal(JSON.parse(reset.body).reset, true);
  // After reset, the next message is treated as a fresh thread (length back to 2).
  const after = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'again', sessionId: 's1' } });
  assert.equal(JSON.parse(after.body).historyLength, 2);
});

test('test-chat does not poison memory when the reply is empty', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    { generateInstagramTestReply: async () => ({ reply: '', aiEnabled: false }) },
  );
  const res = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'hi', sessionId: 's1' } });
  const b = JSON.parse(res.body);
  assert.equal(b.empty, true);
  assert.equal(b.historyLength, 0);   // the user turn was rolled back
});

test('test-chat is gated by INSTAGRAM_ENABLED (503 when off)', async () => {
  const app = makeApp({ INSTAGRAM_ENABLED: 'false' });
  const res = await req(app, 'POST', '/api/instagram/test-chat', { body: { message: 'hi' } });
  assert.equal(res.status, 503);
});

// ── Webhook subscription status + re-subscribe ──────────────────────────────

test('subscription status reports hasMessages from the Graph API', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    {
      accounts: { getAccountToken: async () => 'TOK' },
      graph: { getSubscribedApps: async () => ({ fields: ['messages', 'comments'], hasMessages: true }) },
    },
  );
  const res = await req(app, 'GET', '/api/instagram/subscription');
  const d = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(d.connected, true);
  assert.equal(d.hasMessages, true);
  assert.deepEqual(d.fields, ['messages', 'comments']);
});

test('subscription status flags missing messages field', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    {
      accounts: { getAccountToken: async () => 'TOK' },
      graph: { getSubscribedApps: async () => ({ fields: ['comments'], hasMessages: false }) },
    },
  );
  const d = JSON.parse((await req(app, 'GET', '/api/instagram/subscription')).body);
  assert.equal(d.hasMessages, false);
});

test('resubscribe calls subscribeToMessages and returns the resulting fields', async () => {
  let subscribed = false;
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    {
      accounts: { getAccountToken: async () => 'TOK' },
      graph: {
        subscribeToMessages: async () => { subscribed = true; return { success: true }; },
        getSubscribedApps: async () => ({ fields: ['messages'], hasMessages: true }),
      },
    },
  );
  const res = await req(app, 'POST', '/api/instagram/resubscribe', { body: {} });
  const d = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(subscribed, true);
  assert.equal(d.success, true);
  assert.equal(d.hasMessages, true);
});

test('resubscribe returns 400 when the merchant has no token', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    { accounts: { getAccountToken: async () => null } },
  );
  const res = await req(app, 'POST', '/api/instagram/resubscribe', { body: {} });
  assert.equal(res.status, 400);
});

test('resubscribe surfaces the Graph error (502) instead of swallowing it', async () => {
  const app = makeApp(
    { INSTAGRAM_ENABLED: 'true' },
    {
      accounts: { getAccountToken: async () => 'TOK' },
      graph: { subscribeToMessages: async () => { throw new Error('ig_subscribe_failed: 400 permission'); } },
    },
  );
  const res = await req(app, 'POST', '/api/instagram/resubscribe', { body: {} });
  const d = JSON.parse(res.body);
  assert.equal(res.status, 502);
  assert.match(d.message, /permission/);
});
