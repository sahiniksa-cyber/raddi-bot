'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { buildFixtureCorpus, createLegacyOracleEvidence } = require('../scripts/legacy-exceljs-oracle');

const execFileAsync = promisify(execFile);

test('legacy ExcelJS oracle preserves semantic import, export, and ledger behavior', async () => {
  const evidence = await createLegacyOracleEvidence();
  const committedEvidence = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', 'docs', 'stabilization', 'dependency-hardening', 'legacy-exceljs-oracle.json',
  ), 'utf8'));

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
  assert.equal(evidence.imports.semanticWorkbook.sourceWorkbook.sheets[0].rows[1].cells[3].text, 'date:2026-07-16T00:00:00.000Z');
  assert.deepEqual(evidence.imports.largeWorkbook.result, {
    added: 1024, duplicates: 0, ordered: 1024, subscriptions: 0, invalid: [], totalRows: 1024,
  });
  assert.deepEqual(evidence.imports.largeWorkbook.fixture, {
    fileName: 'large-workbook.xlsx',
  });
  assert.deepEqual(evidence.exports.signalExport.sheetOrder, [
    'مهتمون بلا طلب مؤكد',
    'الطلبات المؤكدة',
    'يحتاجون تحقق',
  ]);
  const templatePresentation = evidence.exports.contactTemplate.sheets[0].presentation;
  assert.deepEqual(templatePresentation, {
    rightToLeft: true,
    columnWidths: [20, 24, 18, 30, 20, 18, 18, 18],
    autoFilter: 'A1:H1',
    headerBold: [true, true, true, true, true, true, true, true],
    dataValidation: {
      count: 999,
      first: { address: 'C2', validation: { type: 'list', formulae: ['"عميل,طلب,اشتراك"'], allowBlank: true } },
      last: { address: 'C1000', validation: { type: 'list', formulae: ['"عميل,طلب,اشتراك"'], allowBlank: true } },
    },
  });
  const billingCells = evidence.billingLedger.persistedWorkbook.sheets[0].rows[1].cells;
  assert.equal(billingCells[3].value, 1750);
  assert.equal(billingCells[4].value, 'SAR');
  assert.equal(billingCells[5].value, 'manual');
  assert.deepEqual(evidence.billingLedger.appendAttempts, [
    { appendOrder: 1, row: { date: { type: 'date', value: '2026-07-26T10:00:00.000Z' }, name: 'ليان Al-Harbi', email: 'layan@example.com', amount: 1750, currency: 'SAR', method: 'manual', providerPaymentId: 'manual-1', status: 'paid', activationType: 'paid', note: 'فاتورة ✨' } },
    { appendOrder: 2, row: { date: { type: 'date', value: '2026-07-27T10:00:00.000Z' }, name: 'John Smith', email: 'john@example.com', amount: 19.99, currency: 'USD', method: 'card', providerPaymentId: 'pay-2', status: 'paid', activationType: 'trial', note: '19.99 USD' } },
  ]);
  assert.equal(evidence.billingLedger.persistedWorkbook.sheets[0].rows.length, 2);
  assert.equal(evidence.billingLedger.knownLegacyBehavior.category, 'EXCELJS_LEDGER_SECOND_APPEND_LOST');
  const invalidFileError = {
    category: 'INVALID_CONTACT_FILE', code: 'INVALID_CONTACT_FILE', statusCode: 400,
    message: 'تعذر قراءة الملف. تأكد أنه ملف CSV أو XLSX صالح',
  };
  assert.deepEqual(evidence.imports.corruptXlsx.error, invalidFileError);
  assert.deepEqual(evidence.imports.emptyXlsx.error, invalidFileError);
  assert.deepEqual(evidence.imports.spoofedXlsx.error, invalidFileError);
  assert.deepEqual(evidence.imports.unsupportedExtension.error, {
    category: 'BAD_REQUEST', code: 'BAD_REQUEST', statusCode: 400,
    message: 'صيغة الملف غير مدعومة. استخدم CSV أو XLSX',
  });
  assert.deepEqual(evidence, committedEvidence);
});

test('large workbook corpus fixture exceeds 64 KiB outside canonical evidence', async () => {
  const fixtures = await buildFixtureCorpus();

  assert.ok(fixtures.largeWorkbook.buffer.length > 64 * 1024);
});

test('legacy oracle canonical evidence is deterministic across concurrent subprocesses', async () => {
  const projectRoot = path.join(__dirname, '..');
  const generateEvidence = [
    "const { createLegacyOracleEvidence } = require('./scripts/legacy-exceljs-oracle');",
    'createLegacyOracleEvidence()',
    "  .then(evidence => process.stdout.write(JSON.stringify(evidence)))",
    "  .catch(error => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });",
  ].join('');
  const runGenerator = () => execFileAsync(
    process.execPath,
    ['-e', generateEvidence],
    { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 },
  );

  const [left, right] = await Promise.all([runGenerator(), runGenerator()]);
  const leftEvidence = JSON.parse(left.stdout);
  const rightEvidence = JSON.parse(right.stdout);

  assert.deepEqual(leftEvidence, rightEvidence);
  for (const importEvidence of Object.values(leftEvidence.imports)) {
    assert.deepEqual(
      Object.keys(importEvidence.fixture),
      ['fileName'],
      'canonical fixture evidence must contain semantic identity only',
    );
  }
});
