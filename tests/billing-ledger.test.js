'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLedgerRow } = require('../src/services/billing/excel-ledger');

test('buildLedgerRow formats a payment record for the Excel ledger', () => {
  const row = buildLedgerRow({
    user: { name: 'Mohammed', email: 'm@example.com' },
    amountHalalas: 175000,
    currency: 'SAR',
    method: 'admin',
    providerPaymentId: 'manual-1',
    status: 'paid',
    activationType: 'paid',
  });

  assert.equal(row.name, 'Mohammed');
  assert.equal(row.email, 'm@example.com');
  assert.equal(row.amount, 1750);
  assert.equal(row.currency, 'SAR');
  assert.equal(row.activationType, 'paid');
});
