'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildFixtureCorpus,
  createCurrentSpreadsheetEvidence,
} = require('../scripts/legacy-exceljs-oracle');

const evidencePath = path.join(
  __dirname,
  '..',
  'docs',
  'stabilization',
  'dependency-hardening',
  'legacy-exceljs-oracle.json',
);

function importContract(evidence) {
  return Object.fromEntries(Object.entries(evidence).map(([name, item]) => [name, {
    fixture: item.fixture,
    result: item.result,
    acceptedRecipientCount: item.acceptedRecipientCount,
    rejectedRecipientCount: item.rejectedRecipientCount,
    normalizedPhones: item.normalizedPhones,
    contactWriteOrder: item.contactWriteOrder,
    error: item.error,
  }]));
}

function normalizeCellValue(value) {
  return value === null ? '' : value;
}

function trimTrailingEmptyCells(values) {
  const trimmed = [...values];
  while (trimmed.length && trimmed.at(-1) === '') trimmed.pop();
  return trimmed;
}

function workbookContract(workbooks) {
  return Object.fromEntries(Object.entries(workbooks).map(([name, workbook]) => [name, {
    sheetOrder: workbook.sheetOrder,
    sheets: workbook.sheets.map(sheet => ({
      name: sheet.name,
      presentation: {
        rightToLeft: sheet.presentation.rightToLeft,
        columnWidths: sheet.presentation.columnWidths,
        autoFilter: sheet.presentation.autoFilter,
        headerBold: sheet.presentation.headerBold,
        dataValidation: sheet.presentation.dataValidation,
      },
      rows: sheet.rows
        .filter(row => row.cells.length)
        .map(row => trimTrailingEmptyCells(row.cells.map(cell => normalizeCellValue(cell.value)))),
    })),
  }]));
}

test('adapter wiring matches the frozen fixture corpus with only the approved ledger repair', async () => {
  const fixtures = await buildFixtureCorpus();
  const before = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const after = await createCurrentSpreadsheetEvidence();

  assert.equal(before.oracle, 'legacy-exceljs-4.4.0');
  assert.equal(after.oracle, 'current-spreadsheet-call-sites');
  assert.deepEqual(Object.keys(fixtures), Object.keys(before.imports));
  assert.ok(fixtures.largeWorkbook.buffer.length > 64 * 1024);
  assert.deepEqual(importContract(after.imports), importContract(before.imports), 'campaign import behavior delta is not approved');
  assert.equal(after.imports.validCsv.sourceWorkbook.sheets[0].rows[1].cells[0].value, '0551234571');
  assert.equal(after.imports.semanticWorkbook.sourceWorkbook.sheets[0].rows[5].cells[3].value, null);
  assert.deepEqual(workbookContract(after.exports), workbookContract(before.exports), 'campaign export delta is not approved');
  assert.deepEqual(after.billingLedger.appendAttempts, before.billingLedger.appendAttempts);
  assert.deepEqual(
    after.billingLedger.persistedWorkbook.sheets[0].rows.slice(0, 2),
    before.billingLedger.persistedWorkbook.sheets[0].rows,
    'the existing ledger header/first row changed',
  );
  assert.deepEqual(after.billingLedger.persistedWorkbook.sheets[0].rows[2], {
    row: 3,
    cells: [
      { address: 'A3', column: 1, value: { type: 'date', value: '2026-07-27T10:00:00.000Z' }, text: 'date:2026-07-27T10:00:00.000Z' },
      { address: 'B3', column: 2, value: 'John Smith', text: 'John Smith' },
      { address: 'C3', column: 3, value: 'john@example.com', text: 'john@example.com' },
      { address: 'D3', column: 4, value: 19.99, text: '19.99' },
      { address: 'E3', column: 5, value: 'USD', text: 'USD' },
      { address: 'F3', column: 6, value: 'card', text: 'card' },
      { address: 'G3', column: 7, value: 'pay-2', text: 'pay-2' },
      { address: 'H3', column: 8, value: 'paid', text: 'paid' },
      { address: 'I3', column: 9, value: 'trial', text: 'trial' },
      { address: 'J3', column: 10, value: '19.99 USD', text: '19.99 USD' },
    ],
  });
  assert.equal(after.billingLedger.persistedWorkbook.sheets[0].rows.length, 3);
  assert.deepEqual(
    {
      ...after.billingLedger,
      persistedWorkbook: {
        ...after.billingLedger.persistedWorkbook,
        sheets: after.billingLedger.persistedWorkbook.sheets.map((sheet, index) => (
          index === 0 ? { ...sheet, rows: sheet.rows.slice(0, 2) } : sheet
        )),
      },
    },
    before.billingLedger,
    'a billing delta outside EXCELJS_LEDGER_SECOND_APPEND_LOST is not approved',
  );
});
