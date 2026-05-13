'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

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

async function appendLedgerRow(record, { dataDir } = {}) {
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(file)) {
    await workbook.xlsx.readFile(file);
  }
  const sheet = workbook.getWorksheet('Payments') || workbook.addWorksheet('Payments');
  if (sheet.rowCount === 0) {
    sheet.columns = [
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
  }
  sheet.addRow(buildLedgerRow(record));
  await workbook.xlsx.writeFile(file);
  return file;
}

module.exports = {
  appendLedgerRow,
  buildLedgerRow,
  ledgerPath,
};
