'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCallbackUrl,
  isPaidPlatformAccessPayment,
  normalizeMoyasarPayment,
} = require('../src/services/billing/moyasar-client');

test('buildCallbackUrl uses configured app base url', () => {
  assert.equal(
    buildCallbackUrl({ appBaseUrl: 'https://example.com' }),
    'https://example.com/billing/callback',
  );
});

test('normalizeMoyasarPayment extracts safe payment fields', () => {
  const payment = normalizeMoyasarPayment({
    id: 'pay_1',
    status: 'paid',
    amount: 175000,
    currency: 'SAR',
    source: { type: 'creditcard', company: 'visa', number: '411111******1111' },
    metadata: { user_id: 'user-1' },
  });

  assert.equal(payment.id, 'pay_1');
  assert.equal(payment.status, 'paid');
  assert.equal(payment.method, 'creditcard');
  assert.equal(payment.userId, 'user-1');
});

test('isPaidPlatformAccessPayment validates status amount and currency', () => {
  const settings = { platformAccessPriceHalalas: 175000, currency: 'SAR' };

  assert.equal(isPaidPlatformAccessPayment({ status: 'paid', amount: 175000, currency: 'SAR' }, settings), true);
  assert.equal(isPaidPlatformAccessPayment({ status: 'initiated', amount: 175000, currency: 'SAR' }, settings), false);
  assert.equal(isPaidPlatformAccessPayment({ status: 'paid', amount: 100, currency: 'SAR' }, settings), false);
  assert.equal(isPaidPlatformAccessPayment({ status: 'paid', amount: 175000, currency: 'USD' }, settings), false);
});
