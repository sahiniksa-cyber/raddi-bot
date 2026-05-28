'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminRoutes } = require('../src/routes/admin.routes');

test('admin login route has a tight rate limiter (<=5 per 15min)', () => {
  let limiterOpts = null;
  const fakeRateLimit = (opts) => {
    limiterOpts = opts;
    return (req, res, next) => next();
  };

  createAdminRoutes({
    rateLimitFactory: fakeRateLimit,
    requireAuth: (req, _res, next) => next(),
    billingSettings: { adminSecretPath: '/owner' },
    dashboardDir: '/tmp',
  });

  assert.ok(limiterOpts, 'rate limit factory must be invoked');
  assert.ok(limiterOpts.windowMs >= 5 * 60 * 1000, 'window should be >=5 minutes');
  assert.ok(limiterOpts.max <= 5, `admin login max attempts must be <=5 (got ${limiterOpts.max})`);
});

test('admin login requires existing user session by default', async () => {
  const express = require('express');
  const http = require('http');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use(createAdminRoutes({
    rateLimitFactory: () => (req, res, next) => next(),
    requireAuth: (req, _res, next) => next(),
    billingSettings: { adminSecretPath: '/owner' },
    dashboardDir: '/tmp',
  }));

  const server = await new Promise(r => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify({ password: 'whatever' });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/admin/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, res => {
        let chunks = '';
        res.on('data', c => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'login_required_first');
  } finally {
    server.close();
  }
});

test('admin login allows password check when ADMIN_REQUIRE_USER_SESSION=false', async () => {
  const express = require('express');
  const http = require('http');

  const originalFlag = process.env.ADMIN_REQUIRE_USER_SESSION;
  const originalPwd = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_REQUIRE_USER_SESSION = 'false';
  process.env.ADMIN_PASSWORD = 'secret-test-pwd';

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use(createAdminRoutes({
    rateLimitFactory: () => (req, res, next) => next(),
    requireAuth: (req, _res, next) => next(),
    billingSettings: { adminSecretPath: '/owner' },
    dashboardDir: '/tmp',
  }));

  const server = await new Promise(r => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const port = server.address().port;
    const body = JSON.stringify({ password: 'wrong-password' });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/admin/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, res => {
        let chunks = '';
        res.on('data', c => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    // Without session-required gate, request reaches the password check and
    // returns 401 with the password-mismatch message instead.
    assert.equal(result.status, 401);
    assert.notEqual(result.body.error, 'login_required_first');
  } finally {
    server.close();
    if (originalFlag === undefined) delete process.env.ADMIN_REQUIRE_USER_SESSION;
    else process.env.ADMIN_REQUIRE_USER_SESSION = originalFlag;
    if (originalPwd === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPwd;
  }
});
