'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBillingSettings, normalizeSecretPath } = require('../src/services/billing/billing-settings');

test('normalizeSecretPath trims and prefixes a safe owner path', () => {
  assert.equal(normalizeSecretPath(' owner-control '), '/owner-control');
  assert.equal(normalizeSecretPath('/owner-control'), '/owner-control');
});

test('normalizeSecretPath rejects unsafe or empty paths', () => {
  assert.equal(normalizeSecretPath(''), null);
  assert.equal(normalizeSecretPath('/'), null);
  assert.equal(normalizeSecretPath('/api/admin'), null);
  assert.equal(normalizeSecretPath('/../admin'), null);
});

test('getBillingSettings parses billing and owner settings', () => {
  const settings = getBillingSettings({
    ADMIN_SECRET_PATH: ' private-owner ',
    ADMIN_EMAILS: 'OWNER@EXAMPLE.COM, second@example.com ',
    PLATFORM_ACCESS_PRICE_HALALAS: '175000',
    MESSAGE_PRICE_HALALAS: '12',
    BILLING_ACCESS_GATE_ENABLED: 'true',
    ADMIN_ACTIVATION_CODES: ' FREE123, owner-pass ',
  });

  assert.equal(settings.adminSecretPath, '/private-owner');
  assert.deepEqual(settings.adminEmails, ['owner@example.com', 'second@example.com']);
  assert.equal(settings.platformAccessPriceHalalas, 175000);
  assert.equal(settings.messagePriceHalalas, 12);
  assert.equal(settings.accessGateEnabled, true);
  assert.deepEqual(settings.activationCodes, ['FREE123', 'owner-pass']);
});

test('getBillingSettings uses safe defaults', () => {
  const settings = getBillingSettings({});

  assert.equal(settings.adminSecretPath, '/owner-control');
  assert.equal(settings.platformAccessPriceHalalas, 175000);
  assert.equal(settings.messagePriceHalalas, 0);
  assert.equal(settings.currency, 'SAR');
  assert.equal(settings.accessGateEnabled, true);
});
