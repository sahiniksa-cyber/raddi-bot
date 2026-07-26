'use strict';

// The committed JSON is the immutable legacy oracle. Fixture construction and
// current-call-site capture remain executable for replacement parity tests, but
// loading OLD evidence must never invoke newly wired production code.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');

const { createCampaignService } = require('../src/services/campaigns/campaign-service');
const { appendLedgerRow, buildLedgerRow } = require('../src/services/billing/excel-ledger');

const LEGACY_EVIDENCE_PATH = path.join(
  __dirname,
  '..',
  'docs',
  'stabilization',
  'dependency-hardening',
  'legacy-exceljs-oracle.json',
);

function semanticValue(value) {
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  if (value && typeof value === 'object') {
    if (value.text !== undefined) return { type: 'rich-text', value: value.text };
    if (value.result !== undefined) return { type: 'formula', value: semanticValue(value.result) };
    return { type: 'object', value: JSON.parse(JSON.stringify(value)) };
  }
  return value;
}

function semanticCellText(cell) {
  // ExcelJS renders Date.text with locale-sensitive formatting. The instant is
  // the semantic contract, so record a canonical representation instead.
  if (cell.value instanceof Date) return `date:${cell.value.toISOString()}`;
  return cell.text;
}

function dataValidationSemantics(sheet) {
  const entries = Object.entries(sheet.dataValidations?.model || {}).sort(([left], [right]) => {
    const [, leftColumn, leftRow] = left.match(/^([A-Z]+)(\d+)$/) || [];
    const [, rightColumn, rightRow] = right.match(/^([A-Z]+)(\d+)$/) || [];
    if (Number(leftRow) !== Number(rightRow)) return Number(leftRow) - Number(rightRow);
    return String(leftColumn) < String(rightColumn) ? -1 : String(leftColumn) > String(rightColumn) ? 1 : 0;
  });
  const capture = ([address, validation]) => ({ address, validation });
  return entries.length ? { count: entries.length, first: capture(entries[0]), last: capture(entries.at(-1)) } : null;
}

function worksheetSemantics(sheet) {
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cells.push({
        address: cell.address,
        column: columnNumber,
        value: semanticValue(cell.value),
        text: semanticCellText(cell),
      });
    });
    rows.push({ row: rowNumber, cells });
  });
  const headerBold = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, cell => { headerBold.push(Boolean(cell.font?.bold)); });
  return {
    name: sheet.name,
    presentation: {
      rightToLeft: Boolean(sheet.views?.[0]?.rightToLeft),
      columnWidths: sheet.columns.map(column => column.width ?? null),
      autoFilter: sheet.autoFilter || null,
      headerBold,
      dataValidation: dataValidationSemantics(sheet),
    },
    rows,
  };
}

function workbookSemantics(workbook) {
  return {
    sheetOrder: workbook.worksheets.map(sheet => sheet.name),
    sheets: workbook.worksheets.map(worksheetSemantics),
  };
}

async function readWorkbookSemantics(buffer, originalName) {
  const workbook = new ExcelJS.Workbook();
  if (String(originalName).toLowerCase().endsWith('.csv')) {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }
  return workbookSemantics(workbook);
}

async function buildWorkbook(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const fixture of sheets) {
    const sheet = workbook.addWorksheet(fixture.name);
    for (const row of fixture.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildFixtureCorpus() {
  const semanticWorkbook = await buildWorkbook([
    {
      name: 'Primary audience',
      rows: [
        ['Phone', 'Customer Name', 'Product', 'Order Date', 'Currency', 'Amount'],
        [' 0551234567 ', 'ليان Al-Harbi', 'خدمة ✨ / Plan™', new Date('2026-07-16T00:00:00.000Z'), 'SAR', 1750.5],
        ['+966551234567', 'Layan duplicate', 'Renewal', '16/07/2026', 'SAR', 19.99],
        [551234568, 'John Smith', 'Basic', '2026-07-17', 'USD', 0.1],
        ['not-a-phone', 'Invalid number', 'Broken', '2026-07-18', 'SAR', 1],
        ['   ', 'Empty phone', 'No recipient', '', 'SAR', 0],
      ],
    },
    {
      name: 'Reordered columns',
      rows: [
        ['Customer Name', 'Order Date', 'Mobile', 'Product'],
        ['مها Noor', '18/07/2026', ' 0551234569 ', 'Premium & Plus'],
        ['Missing phone column value', '2026-07-19', '', 'No recipient'],
        ['Invalid phone', '2026-07-20', '123', 'No recipient'],
      ],
    },
  ]);
  const missingPhoneColumn = await buildWorkbook([
    { name: 'No phone header', rows: [['Name', 'Product'], ['No number', 'Service']] },
  ]);
  const largeRows = [['Phone', 'Customer Name', 'Product', 'Order Date', 'Currency', 'Amount']];
  for (let index = 0; index < 1024; index += 1) {
    const token = crypto.createHash('sha512').update(`legacy-large-row-${index}`).digest('hex');
    largeRows.push([
      `05${String(51300000 + index).padStart(8, '0')}`,
      `Customer ${String(index).padStart(4, '0')} ${token.slice(0, 32)}`,
      `Plan ${token.slice(32, 64)} ✨`,
      `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
      index % 2 ? 'SAR' : 'USD',
      Number(`${index % 100}.${String(index % 100).padStart(2, '0')}`),
    ]);
  }
  const largeWorkbook = await buildWorkbook([{ name: 'Large audience', rows: largeRows }]);
  const validCsv = Buffer.from('phone,name,product\n0551234571,CSV User,CSV & Unicode ✓\n', 'utf8');
  return {
    semanticWorkbook: { fileName: 'semantic-audience.xlsx', buffer: semanticWorkbook },
    missingPhoneColumn: { fileName: 'missing-phone-column.xlsx', buffer: missingPhoneColumn },
    largeWorkbook: { fileName: 'large-workbook.xlsx', buffer: largeWorkbook },
    validCsv: { fileName: 'contacts.csv', buffer: validCsv },
    corruptXlsx: { fileName: 'corrupt.xlsx', buffer: Buffer.from('not an XLSX archive', 'utf8') },
    emptyXlsx: { fileName: 'empty.xlsx', buffer: Buffer.alloc(0) },
    spoofedXlsx: { fileName: 'spreadsheet.xlsx', buffer: Buffer.from('phone,name\n0551234572,Spoofed text', 'utf8') },
    unsupportedExtension: { fileName: 'spreadsheet.txt', buffer: semanticWorkbook },
  };
}

function makeCaptureDatabase() {
  const queries = [];
  return {
    queries,
    database: {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        return { rows: [{ id: `legacy-${queries.length}` }] };
      },
    },
  };
}

function visibleError(error) {
  return {
    category: error.code || 'UNCLASSIFIED_ERROR',
    code: error.code || null,
    statusCode: error.statusCode || null,
    message: error.message,
  };
}

function fixtureSemantics(fixture) {
  return {
    fileName: fixture.fileName,
  };
}

async function captureImport(fixture) {
  const { database, queries } = makeCaptureDatabase();
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  let sourceWorkbook = null;
  try {
    sourceWorkbook = await readWorkbookSemantics(fixture.buffer, fixture.fileName);
  } catch (_) {
    // Import's own user-visible error is the source of truth for unsupported input.
  }
  try {
    const result = await service.importContacts('oracle-user', fixture.buffer, fixture.fileName);
    const inserts = queries.filter(item => /INSERT INTO campaign_contacts/.test(item.sql));
    return {
      fixture: fixtureSemantics(fixture),
      sourceWorkbook,
      result,
      acceptedRecipientCount: result.added,
      rejectedRecipientCount: result.invalid.length,
      normalizedPhones: inserts.map(item => item.params[1]),
      consumedCells: sourceWorkbook ? sourceWorkbook.sheets : [],
      contactWriteOrder: inserts.map(item => ({
        normalizedPhone: item.params[1],
        name: item.params[3],
        customerStatus: item.params[5],
        product: item.params[6],
        orderDate: item.params[8],
        subscriptionStart: item.params[9],
        subscriptionEnd: item.params[10],
      })),
      error: null,
    };
  } catch (error) {
    return {
      fixture: fixtureSemantics(fixture),
      sourceWorkbook,
      result: null,
      acceptedRecipientCount: 0,
      rejectedRecipientCount: 0,
      normalizedPhones: [],
      consumedCells: sourceWorkbook ? sourceWorkbook.sheets : [],
      contactWriteOrder: [],
      error: visibleError(error),
    };
  }
}

function exportDatabase() {
  const contacts = [{
    normalized_phone: '966551234567', name: 'ليان Al-Harbi', customer_status: 'subscription',
    product_name: 'خدمة ✨ / Plan™', order_reference: 'ORD-1001', order_date: '2026-07-16',
    subscription_start_date: '2026-07-01', subscription_end_date: '2027-06-30', source: 'import',
    updated_at: '2026-07-26T00:00:00.000Z',
  }];
  const signals = [
    { normalized_phone: '966551234568', customer_name: 'John Smith', product_name: 'Basic', customer_state: 'interested_unverified', confidence: 0.6, evidence_text: 'Unicode ✓', source: 'merchant_file_import', last_detected_at: '2026-07-25T00:00:00.000Z' },
    { normalized_phone: '966551234567', customer_name: 'ليان', product_name: 'خدمة ✨', customer_state: 'ordered_confirmed', order_reference: 'ORD-1001', confidence: 1, evidence_text: 'طلب مؤكد', source: 'merchant_file_import', last_detected_at: '2026-07-26T00:00:00.000Z' },
    { normalized_phone: '966551234569', customer_name: 'مها', product_name: 'Premium & Plus', customer_state: 'needs_verification', confidence: null, evidence_text: '', source: 'import', last_detected_at: '2026-07-24T00:00:00.000Z' },
  ];
  return {
    query: async sql => ({ rows: /FROM campaign_contacts/.test(sql) ? contacts : signals }),
  };
}

async function captureExport(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbookSemantics(workbook);
}

async function captureExports() {
  const service = createCampaignService({ database: exportDatabase(), getUserBot: async () => ({}) });
  const contactTemplate = await captureExport(await service.exportContactTemplate());
  const contactExport = await captureExport(await service.exportContacts('oracle-user'));
  const signalExport = await captureExport(await service.exportSignals('oracle-user'));
  return { contactTemplate, contactExport, signalExport };
}

async function captureBillingLedger() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-exceljs-oracle-'));
  try {
    const firstRecord = {
      date: new Date('2026-07-26T10:00:00.000Z'), user: { name: 'ليان Al-Harbi', email: 'LAYAN@EXAMPLE.COM' },
      amountHalalas: 175000, currency: 'SAR', method: 'manual', providerPaymentId: 'manual-1',
      status: 'paid', activationType: 'paid', note: 'فاتورة ✨',
    };
    const secondRecord = {
      date: new Date('2026-07-27T10:00:00.000Z'), user: { name: 'John Smith', email: 'John@example.com' },
      amountHalalas: 1999, currency: 'USD', method: 'card', providerPaymentId: 'pay-2',
      status: 'paid', activationType: 'trial', note: '19.99 USD',
    };
    await appendLedgerRow(firstRecord, { dataDir });
    await appendLedgerRow(secondRecord, { dataDir });
    const file = path.join(dataDir, 'billing', 'payments-ledger.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    return {
      appendAttempts: [firstRecord, secondRecord].map((record, index) => ({
        appendOrder: index + 1,
        row: Object.fromEntries(Object.entries(buildLedgerRow(record)).map(([key, value]) => [key, semanticValue(value)])),
      })),
      persistedWorkbook: workbookSemantics(workbook),
      knownLegacyBehavior: {
        category: 'EXCELJS_LEDGER_SECOND_APPEND_LOST',
        message: 'After readFile, ExcelJS does not restore worksheet column keys; the object-form second addRow is empty and is not persisted.',
      },
    };
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function createCurrentSpreadsheetEvidence() {
  const fixtures = await buildFixtureCorpus();
  return {
    oracle: 'current-spreadsheet-call-sites',
    generatedAt: 'deterministic-fixture-corpus',
    fixtureBehavior: {
      workbookSheetTraversal: 'all worksheets in workbook order',
      binaryComparison: 'not used',
    },
    imports: {
      semanticWorkbook: await captureImport(fixtures.semanticWorkbook),
      missingPhoneColumn: await captureImport(fixtures.missingPhoneColumn),
      largeWorkbook: await captureImport(fixtures.largeWorkbook),
      validCsv: await captureImport(fixtures.validCsv),
      corruptXlsx: await captureImport(fixtures.corruptXlsx),
      emptyXlsx: await captureImport(fixtures.emptyXlsx),
      spoofedXlsx: await captureImport(fixtures.spoofedXlsx),
      unsupportedExtension: await captureImport(fixtures.unsupportedExtension),
    },
    exports: await captureExports(),
    billingLedger: await captureBillingLedger(),
  };
}

async function createLegacyOracleEvidence() {
  return JSON.parse(await fs.readFile(LEGACY_EVIDENCE_PATH, 'utf8'));
}

async function main() {
  const output = process.argv[2] || path.join('docs', 'stabilization', 'dependency-hardening', 'legacy-exceljs-oracle.json');
  const evidence = await createLegacyOracleEvidence();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildFixtureCorpus,
  createCurrentSpreadsheetEvidence,
  createLegacyOracleEvidence,
};
