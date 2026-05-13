'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canOpenAdminConsole } = require('../src/routes/admin.routes');

test('canOpenAdminConsole rejects wrong secret path', () => {
  assert.equal(canOpenAdminConsole({
    path: '/wrong',
    user: { role: 'admin', email: 'owner@example.com' },
    settings: { adminSecretPath: '/owner-secret', adminEmails: [] },
  }), false);
});

test('canOpenAdminConsole rejects normal users even on the secret path', () => {
  assert.equal(canOpenAdminConsole({
    path: '/owner-secret',
    user: { role: 'user', email: 'customer@example.com' },
    settings: { adminSecretPath: '/owner-secret', adminEmails: [] },
  }), false);
});

test('canOpenAdminConsole allows admin role on the secret path', () => {
  assert.equal(canOpenAdminConsole({
    path: '/owner-secret',
    user: { role: 'admin', email: 'owner@example.com' },
    settings: { adminSecretPath: '/owner-secret', adminEmails: [] },
  }), true);
});

test('canOpenAdminConsole allows configured owner email on the secret path', () => {
  assert.equal(canOpenAdminConsole({
    path: '/owner-secret',
    user: { role: 'user', email: 'OWNER@EXAMPLE.COM' },
    settings: { adminSecretPath: '/owner-secret', adminEmails: ['owner@example.com'] },
  }), true);
});
