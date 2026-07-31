'use strict';

// Phase 10: CSRF enforcement decision. Default (allowlist) preserves legacy
// behavior; strict (opt-in) is default-deny for every mutating /api request
// except webhooks and explicit skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldEnforceSameOrigin } = require('../src/middleware/require-same-origin');

const PREFIXES = ['/api/admin/', '/api/config', '/api/bot/'];

test('default mode: only allowlisted prefixes are checked (legacy behavior kept)', () => {
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/admin/login', strict: false, protectedPrefixes: PREFIXES }), true);
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/billing/topup', strict: false, protectedPrefixes: PREFIXES }), false);
});

test('strict mode: every mutating /api request is checked', () => {
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/billing/topup', strict: true, protectedPrefixes: PREFIXES }), true);
  assert.equal(shouldEnforceSameOrigin({ method: 'DELETE', path: '/api/learned-replies/5', strict: true }), true);
});

test('strict mode: GET/HEAD are never checked', () => {
  assert.equal(shouldEnforceSameOrigin({ method: 'GET', path: '/api/billing/topup', strict: true }), false);
});

test('strict mode: webhooks are exempt (HMAC-verified, legitimately cross-origin)', () => {
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/billing/webhook/moyasar', strict: true }), false);
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/instagram/webhook', strict: true }), false);
});

test('explicit skip paths are always exempt', () => {
  const skip = new Set(['/api/admin/login']);
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/api/admin/login', strict: true, skipPaths: skip }), false);
});

test('non-/api paths are never checked in strict mode', () => {
  assert.equal(shouldEnforceSameOrigin({ method: 'POST', path: '/login', strict: true }), false);
});
