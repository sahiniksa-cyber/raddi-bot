'use strict';

// This is intentionally a legacy-only oracle.  It drives the currently shipped
// ExcelJS call sites and records observable workbook semantics, never bytes.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');

const { createCampaignService } = require('../src/services/campaigns/campaign-service');
const { appendLedgerRow } = require('../src/services/billing/excel-ledger');

function semanticValue(value) {
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  if (value && typeof value === 'object') {
    if (value.text !== undefined) return { type: 'rich-text', value: value.text };
    if (value.result !== undefined) return { type: 'formula', value: semanticValue(value.result) };
    return { type: 'object', value: JSON.parse(JSON.stringify(value)) };
  }
  return value;
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
        text: cell.text,
      });
    });
    rows.push({ row: rowNumber, cells });
  });
  return { name: sheet.name, rows };
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
  const largeWorkbook = await buildWorkbook([
    { name: 'Large value', rows: [['Phone', 'Customer Name'], ['0551234570', `large-${'x'.repeat(65536)}`]] },
  ]);
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
      fixture: { fileName: fixture.fileName, byteLength: fixture.buffer.length },
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
      fixture: { fileName: fixture.fileName, byteLength: fixture.buffer.length },
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
    await appendLedgerRow({
      date: new Date('2026-07-26T10:00:00.000Z'), user: { name: 'ليان Al-Harbi', email: 'LAYAN@EXAMPLE.COM' },
      amountHalalas: 175000, currency: 'SAR', method: 'manual', providerPaymentId: 'manual-1',
      status: 'paid', activationType: 'paid', note: 'فاتورة ✨',
    }, { dataDir });
    await appendLedgerRow({
      date: new Date('2026-07-27T10:00:00.000Z'), user: { name: 'John Smith', email: 'John@example.com' },
      amountHalalas: 1999, currency: 'USD', method: 'card', providerPaymentId: 'pay-2',
      status: 'paid', activationType: 'trial', note: '19.99 USD',
    }, { dataDir });
    const file = path.join(dataDir, 'billing', 'payments-ledger.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    return { workbook: workbookSemantics(workbook) };
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function createLegacyOracleEvidence() {
  const fixtures = await buildFixtureCorpus();
  return {
    oracle: 'legacy-exceljs-4.4.0',
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

module.exports = { buildFixtureCorpus, createLegacyOracleEvidence };
