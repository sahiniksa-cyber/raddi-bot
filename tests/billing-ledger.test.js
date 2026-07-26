'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { appendLedgerRow, buildLedgerRow } = require('../src/services/billing/excel-ledger');

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

function payment(index) {
  return {
    date: new Date(`2026-07-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`),
    user: { name: `Customer ${index}`, email: `USER${index}@EXAMPLE.COM` },
    amountHalalas: 1000 + index,
    currency: index % 2 ? 'SAR' : 'USD',
    method: 'card',
    providerPaymentId: `pay-${index}`,
    status: 'paid',
    activationType: 'paid',
    note: `append ${index}`,
  };
}

async function readPaymentRows(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('Payments');
  return sheet.getRows(1, sheet.rowCount).map(row => row.values.slice(1));
}

test('first billing append writes the frozen header and exact payment row', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-ledger-first-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const record = payment(1);

  const file = await appendLedgerRow(record, { dataDir });

  const rows = await readPaymentRows(file);
  assert.deepEqual(rows, [
    ['Date', 'Name', 'Email', 'Amount', 'Currency', 'Method', 'Provider Payment ID', 'Status', 'Activation Type', 'Note'],
    [record.date, 'Customer 1', 'user1@example.com', 10.01, 'SAR', 'card', 'pay-1', 'paid', 'paid', 'append 1'],
  ]);
});

test('EXCELJS_LEDGER_SECOND_APPEND_LOST: two sequential appends preserve both exact rows', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-ledger-sequential-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = payment(1);
  const second = payment(2);

  const file = await appendLedgerRow(first, { dataDir });
  await appendLedgerRow(second, { dataDir });

  const rows = await readPaymentRows(file);
  assert.deepEqual(rows.slice(1), [
    [first.date, 'Customer 1', 'user1@example.com', 10.01, 'SAR', 'card', 'pay-1', 'paid', 'paid', 'append 1'],
    [second.date, 'Customer 2', 'user2@example.com', 10.02, 'USD', 'card', 'pay-2', 'paid', 'paid', 'append 2'],
  ]);
});

test('concurrent billing appends serialize per ledger path without dropping any valid row', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-ledger-concurrent-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const records = Array.from({ length: 12 }, (_, index) => payment(index + 1));

  const files = await Promise.all(records.map(record => appendLedgerRow(record, { dataDir })));

  assert.equal(new Set(files).size, 1);
  const rows = await readPaymentRows(files[0]);
  assert.equal(rows.length, records.length + 1);
  assert.deepEqual(
    rows.slice(1).map(row => row[6]).sort(),
    records.map(record => record.providerPaymentId).sort(),
  );
  assert.deepEqual(await fs.readdir(path.dirname(files[0])), ['payments-ledger.xlsx']);
});

test('billing append preserves every existing sheet, row, value, and workbook order', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-ledger-preserve-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const billingDirectory = path.join(dataDir, 'billing');
  const file = path.join(billingDirectory, 'payments-ledger.xlsx');
  await fs.mkdir(billingDirectory, { recursive: true });
  const original = new ExcelJS.Workbook();
  const notes = original.addWorksheet('Notes');
  notes.addRows([['Kind', 'Value'], ['Unicode', 'فاتورة ✨'], ['Decimal', 19.99]]);
  const payments = original.addWorksheet('Payments');
  payments.columns = [
    { header: 'Date', key: 'date', width: 22 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Method', key: 'method', width: 16 },
    { header: 'Provider Payment ID', key: 'providerPaymentId', width: 28 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Activation Type', key: 'activationType', width: 18 },
    { header: 'Note', key: 'note', width: 34 },
  ];
  payments.addRow(buildLedgerRow(payment(1)));
  await original.xlsx.writeFile(file);

  await appendLedgerRow(payment(2), { dataDir });

  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(file);
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), ['Notes', 'Payments']);
  assert.deepEqual(reopened.getWorksheet('Notes').getRows(1, 3).map(row => row.values.slice(1)), [
    ['Kind', 'Value'],
    ['Unicode', 'فاتورة ✨'],
    ['Decimal', 19.99],
  ]);
  assert.deepEqual(reopened.getWorksheet('Payments').getRows(2, 2).map(row => row.values.slice(1)), [
    [payment(1).date, 'Customer 1', 'user1@example.com', 10.01, 'SAR', 'card', 'pay-1', 'paid', 'paid', 'append 1'],
    [payment(2).date, 'Customer 2', 'user2@example.com', 10.02, 'USD', 'card', 'pay-2', 'paid', 'paid', 'append 2'],
  ]);
});

test('billing append accepts an existing valid workbook with no used cells', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-ledger-empty-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const billingDirectory = path.join(dataDir, 'billing');
  const file = path.join(billingDirectory, 'payments-ledger.xlsx');
  await fs.mkdir(billingDirectory, { recursive: true });
  const blank = new ExcelJS.Workbook();
  blank.addWorksheet('Blank source');
  await blank.xlsx.writeFile(file);

  await appendLedgerRow(payment(1), { dataDir });

  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(file);
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), ['Blank source', 'Payments']);
  assert.deepEqual(reopened.getWorksheet('Payments').getRow(2).values.slice(1), [
    payment(1).date, 'Customer 1', 'user1@example.com', 10.01, 'SAR', 'card', 'pay-1', 'paid', 'paid', 'append 1',
  ]);
});
