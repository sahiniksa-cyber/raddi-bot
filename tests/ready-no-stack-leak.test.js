'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock the db and redis dependencies so we can trigger errors deterministically.
const Module = require('module');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

function withMocks(mocks, fn) {
  const cache = new Map();
  Module._load = function (request, parent, ...rest) {
    if (mocks[request]) {
      if (!cache.has(request)) cache.set(request, mocks[request]);
      return cache.get(request);
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  try { return fn(); } finally {
    Module._load = originalLoad;
  }
}

test('readiness endpoint does not leak driver error messages or stacks', async () => {
  // Provide stubs that throw with sensitive info in the messages.
  const fakeDb = {
    isConfigured: () => true,
    ping: async () => { throw new Error('FATAL: password "supersecret" rejected by db host 10.0.0.1:5432'); },
  };
  const fakeRedis = {
    getRedisUrl: () => 'redis://internal-host:6379',
    ping: async () => { throw new Error('AUTH failed on internal-host:6379 with credentials abc:def'); },
  };

  await withMocks({
    '../db/client': fakeDb,
    '../queues/redis': fakeRedis,
  }, async () => {
    // Re-require fresh — purge cache for the controller.
    delete require.cache[require.resolve('../src/controllers/health.controller')];
    const { createHealthController } = require('../src/controllers/health.controller');
    const ctrl = createHealthController({});

    let captured = { status: null, body: null };
    const res = {
      status(code) { captured.status = code; return this; },
      json(payload) { captured.body = payload; return this; },
    };
    await ctrl.readiness({}, res);

    assert.equal(captured.status, 503, 'should be 503 when checks fail');
    const serialized = JSON.stringify(captured.body);
    assert.ok(!/supersecret/.test(serialized), 'must not leak DB password into response');
    assert.ok(!/10\.0\.0\.1/.test(serialized), 'must not leak DB host into response');
    assert.ok(!/internal-host/.test(serialized), 'must not leak Redis hostname into response');
    assert.ok(!/AUTH failed/.test(serialized), 'must not leak driver error verbatim');
    assert.ok(!captured.body.databaseError, 'must not include databaseError field');
    assert.ok(!captured.body.redisError, 'must not include redisError field');
    // Should report generic status codes instead.
    assert.equal(captured.body.checks.database, false);
    assert.equal(captured.body.checks.redis, false);
    assert.equal(captured.body.checks.databaseStatus, 'db_unhealthy');
    assert.equal(captured.body.checks.redisStatus, 'redis_unhealthy');
  });

  // Clean up the cached controller so other tests get the real db client.
  delete require.cache[require.resolve('../src/controllers/health.controller')];
});
