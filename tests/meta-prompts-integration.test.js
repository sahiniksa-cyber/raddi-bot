'use strict';

// Integration tests for the three AI endpoints that consume the new
// `src/services/ai/meta-prompts.js` module after the 2026 6-block refactor:
//   - POST /api/learn-style
//   - POST /api/enhance-text  (only type === 'instructions' is the new path)
//   - POST /api/train-analyze
//
// These tests boot a near-real Express app via `createApp()` from
// src/server.js with heavy dependencies stubbed out via `require.cache`.
// We intercept the OpenAI client at the bot layer so we can capture the
// `messages` array that the endpoint hands to `chat.completions.create`
// and assert against it.
//
// We deliberately do NOT import `src/services/ai/meta-prompts.js` here so
// the test verifies that the *endpoint* (and not just the helper module)
// uses the new methodology. Agent A owns that module; agent B owns its
// unit tests. We are the integration boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Per-test mutable state. The stubs below close over these objects so each
// test can swap them in without re-stubbing.
// ---------------------------------------------------------------------------

let openaiCapture = { lastMessages: null, lastArgs: null, reply: '' };
let dbState = { learnStyleRows: [], queries: [] };
let botConfig = { storeName: 'متجر اختبار' };
let quotaState = { canReply: true, remaining: 100, reason: 'ok' };

// ---------------------------------------------------------------------------
// require.cache stub helper. Mirrors the pattern from
// tests/ai-failure-fallback.test.js.
// ---------------------------------------------------------------------------

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

const ROOT = path.resolve(__dirname, '..');
const P = (...segs) => path.resolve(ROOT, ...segs);

// ---------------------------------------------------------------------------
// Heavy infra stubs — installed once, before requiring src/server.js.
// ---------------------------------------------------------------------------

// db/client: respond to the SELECT used by /api/learn-style; ignore others.
stub(P('src', 'db', 'client.js'), {
  isConfigured: () => true,
  query: async (sql, params) => {
    dbState.queries.push({ sql, params });
    if (/FROM\s+messages/i.test(sql) && /direction\s*=\s*'outbound'/i.test(sql)) {
      return { rows: dbState.learnStyleRows };
    }
    return { rows: [] };
  },
  close: async () => {},
});

// Redis is touched by health endpoints only; provide a no-op surface.
stub(P('src', 'queues', 'redis.js'), {
  pingShared: async () => true,
  closeShared: async () => {},
});

// Migrations run on startup of main(); we never call main(). Stub anyway in
// case any imported module pulls it.
stub(P('src', 'db', 'migrations', 'init.js'), { migrate: async () => {} });

// Session store: not used because we replace express-session with a noop
// below, but server.js does `new PostgresSessionStore()` at app build time.
stub(P('src', 'db', 'session-store.js'), {
  PostgresSessionStore: class {
    constructor() {}
    get() {} set() {} destroy() {} touch() {}
  },
});

// express-session: bypass the real cookie/store machinery and inject a
// pre-authenticated session on every request. Tests flip session.userId
// via the `sessionRef` below. We resolve the package the same way
// src/server.js does so the cache entry is keyed identically.
const sessionRef = { userId: 'test-user', isAdmin: false };
stub('express-session', Object.assign(
  function () {
    return function fakeSession(req, _res, next) {
      req.session = { ...sessionRef, save: cb => cb && cb(), destroy: cb => cb && cb() };
      next();
    };
  },
  { Store: class {} },
));

// Billing access middleware: never gate API calls in tests.
stub(P('src', 'middleware', 'billing-access.js'), {
  createBillingAccessGate: () => (req, _res, next) => next(),
  createBillingApiGate: () => (req, _res, next) => next(),
  shouldAllowBillingView: () => true,
  shouldBypassBillingApiGate: () => true,
});

// Billing settings: simple object the gates expect.
stub(P('src', 'services', 'billing', 'billing-settings.js'), {
  getBillingSettings: () => ({ adminSecretPath: '/owner', enabled: false }),
});

// Message quota: pass-through gate, mutable via `quotaState`.
stub(P('src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ ...quotaState }),
  decrementMessageQuota: async () => ({ success: true, remaining: 99 }),
});

// RuntimeBot: stand-in that exposes the minimum surface used by the three
// endpoints (buildAIClient, recordUsage, config). The OpenAI client it
// returns is our capturing stub.
const fakeBot = {
  config: botConfig,
  _costsResetAt: null,
  async buildAIClient() {
    return {
      model: 'test-model',
      openai: {
        chat: {
          completions: {
            create: async (args) => {
              openaiCapture.lastArgs = args;
              openaiCapture.lastMessages = args?.messages || null;
              return {
                choices: [{ message: { content: openaiCapture.reply || 'STUB_REPLY' } }],
                usage: { prompt_tokens: 100, completion_tokens: 200 },
              };
            },
          },
        },
      },
    };
  },
  recordUsage() {},
  async load() {},
  async saveConfig() {},
  testConversations: new Map(),
};

stub(P('src', 'services', 'bot', 'runtime-bot.js'), {
  RuntimeBot: class {
    constructor() { return fakeBot; }
  },
  cleanupRuntimeStorage: () => {},
});

// Health monitor + alerts + mailer + outgoing worker + ai-recovery — never
// invoked from our endpoints, but server.js imports them at module load.
stub(P('src', 'services', 'monitoring', 'health-monitor.js'), {
  HealthMonitor: class { start() {} stop() {} },
  setActiveMonitor: () => {},
});
stub(P('src', 'services', 'monitoring', 'alerts.js'), { createAlertDispatcher: () => ({}) });
stub(P('src', 'services', 'notify', 'mailer.js'), { createMailer: () => null });
stub(P('src', 'workers', 'outgoing-whatsapp-worker.js'), {
  createOutgoingWhatsappWorker: () => ({ close: async () => {} }),
});
stub(P('src', 'workers', 'ai-recovery.js'), { recoverQueuedAiReplyJobs: async () => ({ recovered: 0 }) });
stub(P('src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: { incomingMessages: 'i', aiReplies: 'a', outgoingWhatsapp: 'o' },
  getQueues: () => ({
    aiReplies: { getWaitingCount: async () => 0, getActiveCount: async () => 0, getDelayedCount: async () => 0, getFailedCount: async () => 0, getFailed: async () => [] },
    outgoingWhatsapp: { getWaitingCount: async () => 0, getActiveCount: async () => 0 },
  }),
  enqueueOutgoingWhatsapp: async () => ({ id: 'x' }),
});

// Bot controller / config controller / conversations controller / dashboard /
// auth / admin / billing / queue / health routes are not the focus. We stub
// the factories so they return inert routers (the app still mounts them, but
// they don't pull in DB-heavy code paths).
const express = require('express');
function inertRouter() {
  return express.Router();
}
stub(P('src', 'controllers', 'bot.controller.js'), {
  createBotController: () => ({
    status: (_q, r) => r.json({}), qr: (_q, r) => r.json({}), qrImage: (_q, r) => r.json({}),
    start: (_q, r) => r.json({}), stop: (_q, r) => r.json({}), restart: (_q, r) => r.json({}),
    clearSession: (_q, r) => r.json({}), sendMessage: (_q, r) => r.json({}),
  }),
});
stub(P('src', 'controllers', 'config.controller.js'), {
  createConfigController: () => ({ getConfig: (_q, r) => r.json({}) }),
  mergeConfigForSave: ({ incoming }) => incoming,
});
stub(P('src', 'controllers', 'conversations.controller.js'), {
  createConversationsController: () => ({ list: (_q, r) => r.json({}) }),
});
stub(P('src', 'routes', 'auth.routes.js'), { createAuthRoutes: () => inertRouter() });
stub(P('src', 'routes', 'admin.routes.js'), { createAdminRoutes: () => inertRouter() });
stub(P('src', 'routes', 'billing.routes.js'), { createBillingRoutes: () => inertRouter() });
stub(P('src', 'routes', 'dashboard.routes.js'), { createDashboardRoutes: () => inertRouter() });
stub(P('src', 'routes', 'health.routes.js'), { createHealthRoutes: () => inertRouter() });
stub(P('src', 'routes', 'queue.routes.js'), { createQueueRoutes: () => inertRouter() });

// Bot platform-features: findAutoReply returns nothing (not used by our 3).
stub(P('src', 'services', 'bot', 'platform-features.js'), { findAutoReply: () => null });

// Products import + store scanner: never invoked by our 3 endpoints.
stub(P('src', 'services', 'products', 'product-import.js'), {
  organizeProductsForConfig: () => ({ products: [] }),
});
stub(P('lib', 'store-scanner.js'), { scanStore: async () => ({}) });

// SSRF + same-origin middleware: not relevant on our test routes.
stub(P('src', 'middleware', 'require-same-origin.js'), (req, _res, next) => next());
stub(P('src', 'middleware', 'ssrf-guard.js'), { assertPublicUrl: async () => {} });

// helmet: harmless to load if present, but the server has a fallback path.
// No stub needed.

// ---------------------------------------------------------------------------
// Now require the real src/server.js. createApp will use everything above.
// ---------------------------------------------------------------------------

const { createApp } = require('../src/server');

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------

function startServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function postJson(port, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        // Same-origin guard would normally inspect headers; our middleware is
        // stubbed but we send Origin anyway for realism.
        Origin: `http://127.0.0.1:${port}`,
        ...extraHeaders,
      },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks || '{}'); } catch (_) { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function resetCaptures() {
  openaiCapture = { lastMessages: null, lastArgs: null, reply: '<identity>x</identity>' };
  dbState = { learnStyleRows: [], queries: [] };
  quotaState = { canReply: true, remaining: 100, reason: 'ok' };
  sessionRef.userId = 'test-user';
  sessionRef.isAdmin = false;
}

async function withApp(fn) {
  resetCaptures();
  const app = createApp();
  const { server, port } = await startServer(app);
  try {
    return await fn({ port });
  } finally {
    await new Promise(r => server.close(() => r()));
  }
}

// Markers that the 6-block 2026 methodology must surface in the system prompt.
const SIX_BLOCKS = ['identity', 'persona_tone', 'scope', 'critical_rules', 'examples'];
const HEARD_RE = /HEARD|Hear[\s,_-]*Empathize|اسمع.*تعاطف/i;
const SAUDI_RE = /لهجة|سعودي|سعودية|نجدي|حجازي|خليجي/;

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('POST /api/train-analyze: messages sent to OpenAI carry the 6-block 2026 methodology', async () => {
  await withApp(async ({ port }) => {
    const answers = Array.from({ length: 23 }, (_, i) => ({ q: `سؤال ${i + 1}`, a: `جواب ${i + 1}` }));
    const r = await postJson(port, '/api/train-analyze', { answers });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    assert.equal(r.body.success, true, 'response shape: success=true');
    assert.equal(typeof r.body.instructions, 'string', 'response shape: instructions is a string');

    assert.ok(openaiCapture.lastMessages, 'OpenAI must have been called');
    const sys = String(openaiCapture.lastMessages[0]?.content || '');
    for (const block of SIX_BLOCKS) {
      assert.ok(sys.includes(block), `system prompt missing 6-block marker: ${block}`);
    }
    assert.ok(HEARD_RE.test(sys), 'HEARD framework not referenced in system prompt');
    assert.ok(SAUDI_RE.test(sys), 'Saudi dialect not referenced in system prompt');
  });
});

test('POST /api/train-analyze: rejects when fewer than 10 answers (existing contract preserved)', async () => {
  await withApp(async ({ port }) => {
    const r = await postJson(port, '/api/train-analyze', { answers: [{ q: 'x', a: 'y' }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.success, false);
  });
});

test('POST /api/enhance-text type=instructions: uses 6-block meta-prompt', async () => {
  await withApp(async ({ port }) => {
    const r = await postJson(port, '/api/enhance-text', {
      text: 'ابيك ترد بلهجة سعودية وما تستخدم كلمات مزعجة',
      type: 'instructions',
      storeName: 'متجري',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(typeof r.body.text, 'string', 'response shape: { success, text }');

    const sys = String(openaiCapture.lastMessages?.[0]?.content || '');
    assert.ok(sys.includes('identity'), '6-block identity marker missing');
    assert.ok(sys.includes('persona_tone'), '6-block persona_tone marker missing');
    // The 2026 methodology calls out forbidden phrases / register; we accept
    // any of the well-known markers.
    assert.ok(
      /forbidden_words|critical_rules|للأسف|مستحيل|محظور/.test(sys),
      'forbidden-words / critical-rules signal missing from instructions meta-prompt',
    );
  });
});

test('POST /api/enhance-text type=welcome: NOT changed — stays a compact simple prompt', async () => {
  await withApp(async ({ port }) => {
    const r = await postJson(port, '/api/enhance-text', {
      text: 'مرحبا بكم في متجرنا',
      type: 'welcome',
      storeName: 'متجري',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);

    const sys = String(openaiCapture.lastMessages?.[0]?.content || '');
    // Other types must NOT have been swapped to the heavy meta-prompt — they
    // are intentionally out of scope for the 6-block refactor. We treat the
    // size of the prompt as a proxy: the 2026 meta-prompt is large (>3KB).
    assert.ok(
      sys.length < 3000,
      `welcome prompt should stay compact (<3000 chars) — got ${sys.length}. Did the refactor over-reach?`,
    );
    // And it should not announce the 6 XML blocks.
    const blocksFound = SIX_BLOCKS.filter(b => sys.includes(b));
    assert.ok(
      blocksFound.length <= 1,
      `welcome prompt unexpectedly contains 6-block markers: ${blocksFound.join(',')}`,
    );
  });
});

test('POST /api/learn-style: meta-prompt asks for XML/structured style blocks', async () => {
  await withApp(async ({ port }) => {
    dbState.learnStyleRows = Array.from({ length: 80 }, (_, i) => ({ content: `رد سابق رقم ${i + 1} لعميل` }));
    openaiCapture.reply = '<persona_tone>...</persona_tone><style_signature>...</style_signature><examples>...</examples>';

    const r = await postJson(port, '/api/learn-style', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(typeof r.body.instructions, 'string', 'response shape: { success, instructions, sampledCount }');
    assert.equal(r.body.sampledCount, 80, 'sampledCount preserved in response');

    const sys = String(openaiCapture.lastMessages?.[0]?.content || '');
    assert.ok(sys.includes('persona_tone'), 'learn-style meta-prompt must ask for persona_tone block');
    assert.ok(
      sys.includes('style_signature') || sys.includes('signature') || sys.includes('style'),
      'learn-style meta-prompt must reference a style/signature block',
    );
    assert.ok(sys.includes('examples'), 'learn-style meta-prompt must request examples block');
  });
});

test('POST /api/learn-style: returns success=false when samples < 5 (contract preserved)', async () => {
  await withApp(async ({ port }) => {
    dbState.learnStyleRows = [{ content: 'رد واحد' }, { content: 'رد ثاني' }];
    const r = await postJson(port, '/api/learn-style', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.success, false);
    // OpenAI must not have been called when sample is insufficient.
    assert.equal(openaiCapture.lastMessages, null, 'OpenAI must not be called when sample is too small');
  });
});

test('all three endpoints: response shapes are unchanged (frontend contract intact)', async () => {
  await withApp(async ({ port }) => {
    // train-analyze → { success, instructions }
    const r1 = await postJson(port, '/api/train-analyze', {
      answers: Array.from({ length: 12 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })),
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(Object.keys(r1.body).sort(), ['instructions', 'success'].sort());

    // enhance-text → { success, text }
    const r2 = await postJson(port, '/api/enhance-text', { text: 'نص للتحسين هنا', type: 'instructions' });
    assert.equal(r2.status, 200);
    assert.deepEqual(Object.keys(r2.body).sort(), ['success', 'text'].sort());

    // learn-style → { success, instructions, sampledCount }
    dbState.learnStyleRows = Array.from({ length: 10 }, (_, i) => ({ content: `رد ${i}` }));
    const r3 = await postJson(port, '/api/learn-style', {});
    assert.equal(r3.status, 200);
    assert.deepEqual(
      Object.keys(r3.body).sort(),
      ['instructions', 'sampledCount', 'success'].sort(),
    );
  });
});

test('train-analyze: still gated by aiQuotaGate (402 when quota empty)', async () => {
  await withApp(async ({ port }) => {
    quotaState = { canReply: false, remaining: 0, reason: 'empty' };
    const r = await postJson(port, '/api/train-analyze', {
      answers: Array.from({ length: 15 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })),
    });
    assert.equal(r.status, 402, `expected 402 when quota is empty, got ${r.status}`);
    assert.equal(r.body.success, false);
    assert.equal(openaiCapture.lastMessages, null, 'OpenAI must not be called when quota is exhausted');
  });
});

test('learn-style + enhance-text: also gated by aiQuotaGate', async () => {
  await withApp(async ({ port }) => {
    quotaState = { canReply: false, remaining: 0, reason: 'empty' };

    const r1 = await postJson(port, '/api/learn-style', {});
    assert.equal(r1.status, 402);

    const r2 = await postJson(port, '/api/enhance-text', { text: 'نص للتحسين', type: 'instructions' });
    assert.equal(r2.status, 402);
  });
});
