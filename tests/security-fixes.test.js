'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requireQueueOwner } = require('../src/routes/queue.routes');
const { decideRegisterRole } = require('../src/controllers/auth.controller');
const { detectApiKeyError } = require('../src/controllers/health.controller');
const { createHealthController } = require('../src/controllers/health.controller');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// ───────────────────────── FIX 1: queue owner guard ───────────────────────

test('requireQueueOwner: calls next() for an admin session', () => {
  let called = false;
  const req = { session: { isAdmin: true } };
  const res = fakeRes();
  requireQueueOwner(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.body, null);
});

test('requireQueueOwner: returns 403 for a logged-in non-admin', () => {
  let called = false;
  const req = { session: { userId: 'u-123', isAdmin: false } };
  const res = fakeRes();
  requireQueueOwner(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test('requireQueueOwner: returns 403 when there is no session', () => {
  let called = false;
  const req = {};
  const res = fakeRes();
  requireQueueOwner(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

// ───────────────────────── FIX 2: storage inspect gating ──────────────────

test('storage: basic status returned without inspect (no diagnostics)', () => {
  const controller = createHealthController({ storageStatus: { persistent: true, path: '/data' } });
  const res = fakeRes();
  controller.storage({ query: {}, session: {} }, res);
  assert.equal(res.body.persistent, true);
  assert.equal(res.body.diagnostics, undefined);
});

test('storage: non-admin with inspect=1 gets basic status, NOT diagnostics', () => {
  const controller = createHealthController({ storageStatus: { persistent: true, path: '/data' } });
  const res = fakeRes();
  controller.storage({ query: { inspect: '1' }, session: { userId: 'u-1', isAdmin: false } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.persistent, true);
  assert.equal(res.body.diagnostics, undefined, 'non-admin must not receive cross-tenant diagnostics');
});

test('storage: admin with inspect=1 receives diagnostics listing', () => {
  const controller = createHealthController({ storageStatus: { persistent: true, path: '/data' } });
  const res = fakeRes();
  controller.storage({ query: { inspect: '1' }, session: { userId: 'admin-1', isAdmin: true } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.diagnostics), 'admin should receive a diagnostics array');
});

// ───────────────────────── FIX 3: first-user-admin gating ─────────────────

test('decideRegisterRole: first user is NOT admin by default', () => {
  assert.equal(decideRegisterRole(0, {}), 'user');
});

test('decideRegisterRole: first user is admin only with explicit opt-in', () => {
  assert.equal(decideRegisterRole(0, { ALLOW_FIRST_USER_ADMIN: 'true' }), 'admin');
});

test('decideRegisterRole: opt-in with a non-"true" value does NOT promote', () => {
  assert.equal(decideRegisterRole(0, { ALLOW_FIRST_USER_ADMIN: '1' }), 'user');
  assert.equal(decideRegisterRole(0, { ALLOW_FIRST_USER_ADMIN: 'yes' }), 'user');
});

test('decideRegisterRole: subsequent users are always plain users', () => {
  assert.equal(decideRegisterRole(5, { ALLOW_FIRST_USER_ADMIN: 'true' }), 'user');
  assert.equal(decideRegisterRole(1, {}), 'user');
});

// ───────────────────────── FIX 5: API-key error detection ─────────────────

test('detectApiKeyError: matches the Arabic operator message', () => {
  assert.equal(detectApiKeyError('أضف مفتاح OpenAI في إعدادات المفتاح'), true);
});

test('detectApiKeyError: matches common provider/HTTP signals', () => {
  assert.equal(detectApiKeyError('401 Unauthorized'), true);
  assert.equal(detectApiKeyError('Incorrect API key provided'), true);
  assert.equal(detectApiKeyError('invalid api key'), true);
  assert.equal(detectApiKeyError('No API key configured'), true);
});

test('detectApiKeyError: accepts an array and matches any entry', () => {
  assert.equal(detectApiKeyError(['rate limit exceeded', 'timeout', '401 unauthorized']), true);
  assert.equal(detectApiKeyError(['rate limit exceeded', 'timeout']), false);
});

test('detectApiKeyError: returns false for unrelated errors', () => {
  assert.equal(detectApiKeyError('connection reset by peer'), false);
  assert.equal(detectApiKeyError('500 internal server error'), false);
});

test('detectApiKeyError: handles null/undefined/empty safely', () => {
  assert.equal(detectApiKeyError(null), false);
  assert.equal(detectApiKeyError(undefined), false);
  assert.equal(detectApiKeyError(''), false);
  assert.equal(detectApiKeyError([null, undefined, '']), false);
});
