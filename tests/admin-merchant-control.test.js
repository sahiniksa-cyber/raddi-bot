'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createAdminMerchantController } = require('../src/controllers/admin-merchant.controller');
const { createAdminRoutes } = require('../src/routes/admin.routes');

// ---- helpers ----
function fakeBot(overrides = {}) {
  const calls = [];
  return {
    calls,
    appState: { status: 'connected', qrString: 'QRDATA', ...overrides.appState },
    async restartBot() { calls.push('restartBot'); return true; },
    async stopBot() { calls.push('stopBot'); },
    async clearSession() { calls.push('clearSession'); },
    ...overrides,
  };
}

function fakeDbUserExists(exists = true) {
  return { query: async () => ({ rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 }) };
}

function mockReqRes({ params = {}, body = {}, query = {}, session = { userId: 'admin1' } } = {}) {
  const req = { params, body, query, session };
  const res = {
    statusCode: 200,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    type() { return this; },
    send(p) { this.payload = p; return this; },
    end() { this.ended = true; return this; },
  };
  return { req, res };
}

// ---- controller unit tests ----

test('restart resolves the TARGET userId bot and calls restartBot + audits', async () => {
  const bot = fakeBot();
  let resolvedWith = null;
  const audits = [];
  const ctrl = createAdminMerchantController({
    getUserBot: async (uid) => { resolvedWith = uid; return bot; },
    database: fakeDbUserExists(true),
    services: { logAdminAction: async (rec) => { audits.push(rec); return { logged: true }; } },
  });
  const { req, res } = mockReqRes({ params: { userId: 'merchantX' } });
  await ctrl.restart(req, res);
  assert.equal(resolvedWith, 'merchantX');           // acted on the target, not the admin
  assert.deepEqual(bot.calls, ['restartBot']);
  assert.equal(res.payload.success, true);
  assert.equal(audits[0].action, 'bot_restart');
  assert.equal(audits[0].targetUserId, 'merchantX');
  assert.equal(audits[0].adminUserId, 'admin1');
});

test('stop calls stopBot on the target bot', async () => {
  const bot = fakeBot();
  const ctrl = createAdminMerchantController({
    getUserBot: async () => bot,
    database: fakeDbUserExists(true),
    services: { logAdminAction: async () => ({ logged: true }) },
  });
  const { req, res } = mockReqRes({ params: { userId: 'u1' } });
  await ctrl.stop(req, res);
  assert.deepEqual(bot.calls, ['stopBot']);
  assert.equal(res.payload.success, true);
});

test('clearSession is REJECTED without confirm:true', async () => {
  const bot = fakeBot();
  const ctrl = createAdminMerchantController({
    getUserBot: async () => bot,
    database: fakeDbUserExists(true),
    services: { logAdminAction: async () => ({ logged: true }) },
  });
  const { req, res } = mockReqRes({ params: { userId: 'u1' }, body: {} });
  await ctrl.clearSession(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(bot.calls, []);                   // never touched the bot
});

test('clearSession proceeds with confirm:true', async () => {
  const bot = fakeBot();
  const ctrl = createAdminMerchantController({
    getUserBot: async () => bot,
    database: fakeDbUserExists(true),
    services: { logAdminAction: async () => ({ logged: true }) },
  });
  const { req, res } = mockReqRes({ params: { userId: 'u1' }, body: { confirm: true } });
  await ctrl.clearSession(req, res);
  assert.deepEqual(bot.calls, ['clearSession']);
  assert.equal(res.payload.success, true);
});

test('actions return 404 for a non-existent merchant (and never resolve a bot)', async () => {
  let resolved = false;
  const ctrl = createAdminMerchantController({
    getUserBot: async () => { resolved = true; return fakeBot(); },
    database: fakeDbUserExists(false),
    services: { logAdminAction: async () => ({ logged: true }) },
  });
  const { req, res } = mockReqRes({ params: { userId: 'ghost' } });
  await ctrl.restart(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(resolved, false);                     // FK-unsafe getUserBot avoided
});

test('releaseLease force-clears the lease via forceReleaseLease + audits', async () => {
  const audits = [];
  let releasedFor = null;
  const ctrl = createAdminMerchantController({
    getUserBot: async () => fakeBot(),
    database: fakeDbUserExists(true),
    services: {
      forceReleaseLease: async (uid) => { releasedFor = uid; return { released: true }; },
      logAdminAction: async (rec) => { audits.push(rec); return { logged: true }; },
    },
  });
  const { req, res } = mockReqRes({ params: { userId: 'u1' } });
  await ctrl.releaseLease(req, res);
  assert.equal(releasedFor, 'u1');
  assert.equal(res.payload.released, true);
  assert.equal(audits[0].action, 'bot_release_lease');
});

test('search delegates to searchMerchants', async () => {
  const ctrl = createAdminMerchantController({
    getUserBot: async () => fakeBot(),
    database: fakeDbUserExists(true),
    services: { searchMerchants: async (q) => [{ userId: 'u1', name: 'hit:' + q }] },
  });
  const { req, res } = mockReqRes({ query: { q: '966' } });
  await ctrl.search(req, res);
  assert.equal(res.payload.results[0].name, 'hit:966');
});

test('diagnostics returns 404 when service yields null', async () => {
  const ctrl = createAdminMerchantController({
    getUserBot: async () => fakeBot(),
    database: fakeDbUserExists(true),
    services: { getMerchantDiagnostics: async () => null },
  });
  const { req, res } = mockReqRes({ params: { userId: 'ghost' } });
  await ctrl.diagnostics(req, res);
  assert.equal(res.statusCode, 404);
});

// ---- route wiring / gating tests (real createAdminRoutes) ----

function startApp(adminMerchantController, { withResolver = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { isAdmin: true }; next(); }); // act as admin
  app.use(createAdminRoutes({
    dashboardDir: '/tmp',
    billingSettings: { adminSecretPath: '/admin' },
    getUserBot: withResolver ? (async () => fakeBot()) : undefined,
    adminMerchantController,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function reqJson(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let c = '';
      res.on('data', (x) => { c += x; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(c || '{}'); } catch (_) { body = { _raw: c }; } // express 404 is HTML, not JSON
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('routes are mounted and dispatch to the controller when getUserBot is provided', async () => {
  const hits = [];
  const stub = {
    search: (req, res) => { hits.push('search'); res.json({ success: true, results: [] }); },
    diagnostics: (req, res) => { hits.push('diagnostics:' + req.params.userId); res.json({ success: true }); },
    restart: (req, res) => { hits.push('restart:' + req.params.userId); res.json({ success: true }); },
    stop: (req, res) => res.json({ success: true }),
    clearSession: (req, res) => res.json({ success: true }),
    releaseLease: (req, res) => res.json({ success: true }),
    qrImage: (req, res) => res.end(),
  };
  const { server, port } = await startApp(stub);
  try {
    assert.equal((await reqJson(port, 'GET', '/api/admin/customers/search?q=x')).status, 200);
    assert.equal((await reqJson(port, 'GET', '/api/admin/customers/abc/diagnostics')).status, 200);
    assert.equal((await reqJson(port, 'POST', '/api/admin/customers/abc/bot/restart', {})).status, 200);
    assert.ok(hits.includes('search'));
    assert.ok(hits.includes('diagnostics:abc'));
    assert.ok(hits.includes('restart:abc'));
  } finally {
    server.close();
  }
});

test('merchant-control routes are NOT mounted without a getUserBot resolver', async () => {
  const { server, port } = await startApp(undefined, { withResolver: false });
  try {
    // No resolver → route not registered → 404 from express (no handler).
    const r = await reqJson(port, 'POST', '/api/admin/customers/abc/bot/restart', {});
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});

// ---- Instagram admin route tests (parity with WhatsApp controls) ----

function startAppIg(instagramAdmin, { admin = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = admin ? { isAdmin: true, userId: 'admin1' } : {}; next(); });
  app.use(createAdminRoutes({
    dashboardDir: '/tmp',
    billingSettings: { adminSecretPath: '/admin' },
    instagramAdmin,
    database: { query: async () => ({ rows: [], rowCount: 1 }) }, // audit sink (no real DB)
    // NOTE: deliberately NO getUserBot — Instagram admin must work without it.
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('instagram admin routes dispatch to the service AND need no getUserBot resolver', async () => {
  const calls = [];
  const instagramAdmin = {
    getInstagramMerchantView: async (uid) => { calls.push('view:' + uid); return { connected: true, username: 'shahini', aiEnabled: false }; },
    adminDisconnectInstagram: async (uid) => { calls.push('disc:' + uid); return { disconnected: true }; },
    adminSetInstagramAi: async (uid, enabled) => { calls.push('toggle:' + uid + ':' + enabled); return { aiEnabled: enabled }; },
  };
  const { server, port } = await startAppIg(instagramAdmin);
  try {
    const v = await reqJson(port, 'GET', '/api/admin/customers/u1/instagram');
    assert.equal(v.status, 200);
    assert.equal(v.body.instagram.connected, true);
    assert.equal(v.body.instagram.username, 'shahini');

    const d = await reqJson(port, 'POST', '/api/admin/customers/u1/instagram/disconnect', {});
    assert.equal(d.status, 200);
    assert.equal(d.body.disconnected, true);

    const t = await reqJson(port, 'POST', '/api/admin/customers/u1/instagram/ai-toggle', { enabled: true });
    assert.equal(t.status, 200);
    assert.equal(t.body.aiEnabled, true);

    assert.deepEqual(calls, ['view:u1', 'disc:u1', 'toggle:u1:true']);
  } finally {
    server.close();
  }
});

test('instagram ai-toggle coerces a missing/false enabled flag to false', async () => {
  let passed = null;
  const instagramAdmin = {
    getInstagramMerchantView: async () => ({}),
    adminDisconnectInstagram: async () => ({ disconnected: true }),
    adminSetInstagramAi: async (uid, enabled) => { passed = enabled; return { aiEnabled: enabled }; },
  };
  const { server, port } = await startAppIg(instagramAdmin);
  try {
    const t = await reqJson(port, 'POST', '/api/admin/customers/u1/instagram/ai-toggle', {});
    assert.equal(t.status, 200);
    assert.equal(passed, false);
    assert.equal(t.body.aiEnabled, false);
  } finally {
    server.close();
  }
});

test('instagram admin routes are gated by requireOwner (401 for non-admin)', async () => {
  const instagramAdmin = {
    getInstagramMerchantView: async () => ({}),
    adminDisconnectInstagram: async () => ({}),
    adminSetInstagramAi: async () => ({}),
  };
  const { server, port } = await startAppIg(instagramAdmin, { admin: false });
  try {
    assert.equal((await reqJson(port, 'GET', '/api/admin/customers/u1/instagram')).status, 401);
    assert.equal((await reqJson(port, 'POST', '/api/admin/customers/u1/instagram/disconnect', {})).status, 401);
    assert.equal((await reqJson(port, 'POST', '/api/admin/customers/u1/instagram/ai-toggle', { enabled: true })).status, 401);
  } finally {
    server.close();
  }
});

test('non-admin (no session) is rejected by requireOwner with 401', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = {}; next(); }); // not admin, no userId
  app.use(createAdminRoutes({
    dashboardDir: '/tmp',
    billingSettings: { adminSecretPath: '/admin' },
    getUserBot: async () => fakeBot(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  try {
    const r = await reqJson(port, 'POST', '/api/admin/customers/abc/bot/restart', {});
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});
