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
