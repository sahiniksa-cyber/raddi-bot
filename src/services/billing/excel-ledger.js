'use strict';

const fs = require('fs');
const path = require('path');
const {
  readBillingLedger,
  writeBillingLedgerAtomic,
} = require('../spreadsheets/spreadsheet-adapter');

const PAYMENT_COLUMNS = Object.freeze([
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
]);
const PAYMENT_KEY_BY_HEADER = new Map(PAYMENT_COLUMNS.map(column => [
  column.header.trim().toLowerCase(),
  column.key,
]));
const ledgerQueues = new Map();

function buildLedgerRow(record = {}) {
  return {
    date: record.date || new Date(),
    name: record.user?.name || '',
    email: String(record.user?.email || '').toLowerCase(),
    amount: (Number(record.amountHalalas || 0) / 100),
    currency: record.currency || 'SAR',
    method: record.method || 'manual',
    providerPaymentId: record.providerPaymentId || '',
    status: record.status || 'paid',
    activationType: record.activationType || 'paid',
    note: record.note || '',
  };
}

function ledgerPath(dataDir) {
  return path.join(dataDir || process.env.DATA_DIR || process.cwd(), 'billing', 'payments-ledger.xlsx');
}

function ledgerRowValues(record, columns = PAYMENT_COLUMNS) {
  const row = buildLedgerRow(record);
  return columns.map(column => {
    const key = PAYMENT_KEY_BY_HEADER.get(String(column.header ?? '').trim().toLowerCase());
    return key ? row[key] : null;
  });
}

function restoreSheet(sheet) {
  const header = sheet.rows[0] || [];
  if (sheet.name === 'Payments' && header.length === 0) {
    return {
      name: sheet.name,
      columns: PAYMENT_COLUMNS.map(column => ({ ...column })),
      rows: [],
    };
  }
  return {
    name: sheet.name,
    columns: header.map((value, index) => {
      const paymentKey = sheet.name === 'Payments'
        ? PAYMENT_KEY_BY_HEADER.get(String(value ?? '').trim().toLowerCase())
        : null;
      const canonicalColumn = paymentKey
        ? PAYMENT_COLUMNS.find(column => column.key === paymentKey)
        : null;
      return {
        header: value,
        key: `column${index + 1}`,
        width: canonicalColumn?.width,
      };
    }),
    rows: sheet.rows.slice(1).map(row => [...row]),
  };
}

async function serializeLedger(file, operation) {
  const prior = ledgerQueues.get(file) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  const queueTail = current.catch(() => {});
  ledgerQueues.set(file, queueTail);
  try {
    return await current;
  } finally {
    if (ledgerQueues.get(file) === queueTail) ledgerQueues.delete(file);
  }
}

async function appendLedgerRow(record, { dataDir } = {}) {
  const file = path.resolve(ledgerPath(dataDir));
  return serializeLedger(file, async () => {
    let sheets = [];
    if (fs.existsSync(file)) {
      const existing = await readBillingLedger(file);
      sheets = existing.sheets.map(restoreSheet);
    }
    let payments = sheets.find(sheet => sheet.name === 'Payments');
    if (!payments) {
      payments = {
        name: 'Payments',
        columns: PAYMENT_COLUMNS.map(column => ({ ...column })),
        rows: [],
      };
      sheets.push(payments);
    }
    payments.rows.push(ledgerRowValues(record, payments.columns));
    await writeBillingLedgerAtomic(file, { sheets });
    return file;
  });
}

module.exports = {
  appendLedgerRow,
  buildLedgerRow,
  ledgerPath,
  PAYMENT_COLUMNS,
};
