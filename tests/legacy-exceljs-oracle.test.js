'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLegacyOracleEvidence } = require('../scripts/legacy-exceljs-oracle');

test('legacy ExcelJS oracle preserves semantic import, export, and ledger behavior', async () => {
  const evidence = await createLegacyOracleEvidence();

  assert.equal(evidence.oracle, 'legacy-exceljs-4.4.0');
  assert.equal(evidence.imports.semanticWorkbook.result.totalRows, 8);
  assert.deepEqual(evidence.imports.semanticWorkbook.normalizedPhones, [
    '966551234567',
    '966551234567',
    '966551234568',
    '966551234569',
  ]);
  assert.equal(evidence.imports.semanticWorkbook.result.added, 3);
  assert.equal(evidence.imports.semanticWorkbook.result.duplicates, 1);
  assert.equal(evidence.imports.semanticWorkbook.result.invalid.length, 4);
  assert.deepEqual(evidence.exports.signalExport.sheetOrder, [
    'مهتمون بلا طلب مؤكد',
    'الطلبات المؤكدة',
    'يحتاجون تحقق',
  ]);
  const billingCells = evidence.billingLedger.workbook.sheets[0].rows[1].cells;
  assert.equal(billingCells[3].value, 1750);
  assert.equal(billingCells[4].value, 'SAR');
  assert.equal(billingCells[5].value, 'manual');
  assert.equal(evidence.imports.corruptXlsx.error.code, 'INVALID_CONTACT_FILE');
  assert.equal(evidence.imports.emptyXlsx.error.code, 'INVALID_CONTACT_FILE');
});
