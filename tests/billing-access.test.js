'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldAllowBillingView,
  shouldEnableBillingGate,
  shouldBypassBillingApiGate,
} = require('../src/middleware/billing-access');

test('shouldEnableBillingGate is enabled unless explicitly false', () => {
  assert.equal(shouldEnableBillingGate({ accessGateEnabled: true }), true);
  assert.equal(shouldEnableBillingGate({ accessGateEnabled: false }), false);
  assert.equal(shouldEnableBillingGate({}), true);
});

test('shouldBypassBillingApiGate allows auth billing and admin routes', () => {
  assert.equal(shouldBypassBillingApiGate('/api/auth/login'), true);
  assert.equal(shouldBypassBillingApiGate('/api/billing/state'), true);
  assert.equal(shouldBypassBillingApiGate('/api/admin/customers'), true);
  assert.equal(shouldBypassBillingApiGate('/api/health'), true);
  assert.equal(shouldBypassBillingApiGate('/api/status'), false);
  assert.equal(shouldBypassBillingApiGate('/api/config'), false);
});

test('shouldAllowBillingView keeps the main page available for unpaid users', () => {
  assert.equal(shouldAllowBillingView({ accessActive: false, accessBypass: false }), true);
});
