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

test('adapter wiring matches the frozen fixture corpus with only the approved ledger repair', async () => {
  const fixtures = await buildFixtureCorpus();
  const before = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const after = await createCurrentSpreadsheetEvidence();

  assert.equal(before.oracle, 'legacy-exceljs-4.4.0');
  assert.equal(after.oracle, 'current-spreadsheet-call-sites');
  assert.deepEqual(Object.keys(fixtures), Object.keys(before.imports));
  assert.ok(fixtures.largeWorkbook.buffer.length > 64 * 1024);
  assert.deepEqual(after.imports, before.imports, 'campaign import delta is not approved');
  assert.deepEqual(after.exports, before.exports, 'campaign export delta is not approved');
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
