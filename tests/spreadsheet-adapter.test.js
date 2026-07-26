'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');

const {
  LIMITS,
  readSpreadsheet,
  spoolUploadToTempFile,
  writeSpreadsheetBuffer,
  readBillingLedger,
  writeBillingLedgerAtomic,
} = require('../src/services/spreadsheets/spreadsheet-adapter');

async function makeWorkbook(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const fixture of sheets) {
    const sheet = workbook.addWorksheet(fixture.name);
    for (const row of fixture.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function makeTempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spreadsheet-adapter-test-'));
}

async function captureWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test('reads every XLSX sheet in workbook order with exact used cells and value types', async () => {
  const instant = new Date('2026-07-16T00:00:00.000Z');
  const input = await makeWorkbook([
    {
      name: 'الجمهور الأساسي',
      rows: [
        ['Phone', 'Customer Name', 'Order Date', 'Currency', 'Amount'],
        [' 0551234567 ', 'ليان ✨', instant, 'SAR', 1750.5],
        [551234568, 'John Smith', '2026-07-17', 'USD', 19.99],
      ],
    },
    {
      name: 'Reordered columns',
      rows: [
        ['Customer Name', 'Mobile'],
        ['مها Noor', ' +966551234569 '],
      ],
    },
  ]);

  const result = await readSpreadsheet({ source: input, originalName: 'audience.xlsx' });

  assert.equal(result.rowCount, 5);
  assert.deepEqual(result.sheets.map(sheet => sheet.name), ['الجمهور الأساسي', 'Reordered columns']);
  assert.deepEqual(result.sheets[0].rows, [
    ['Phone', 'Customer Name', 'Order Date', 'Currency', 'Amount'],
    [' 0551234567 ', 'ليان ✨', instant, 'SAR', 1750.5],
    [551234568, 'John Smith', '2026-07-17', 'USD', 19.99],
  ]);
  assert.deepEqual(result.sheets[1].rows, [
    ['Customer Name', 'Mobile'],
    ['مها Noor', ' +966551234569 '],
  ]);
});

test('reads XLSX from a file path without requiring an upload Buffer', async t => {
  const directory = await makeTempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'large-upload.xlsx');
  await fs.writeFile(filePath, await makeWorkbook([
    { name: 'Audience', rows: [['Phone'], ['0551234567']] },
  ]));

  const result = await readSpreadsheet({ source: filePath, originalName: 'large-upload.xlsx' });

  assert.deepEqual(result.sheets[0].rows, [['Phone'], ['0551234567']]);
});

test('keeps CSV parsing behavior including quoted commas, escaped quotes, Unicode, and empty cells', async () => {
  const csv = Buffer.from(
    '\uFEFFphone,name,note,empty\r\n0551234571,"ليان, Layan","قالت ""نعم"" ✨",\r\n',
    'utf8',
  );

  const result = await readSpreadsheet({ source: csv, originalName: 'contacts.CSV' });

  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.sheets, [{
    name: 'sheet1',
    rows: [
      ['phone', 'name', 'note', 'empty'],
      ['0551234571', 'ليان, Layan', 'قالت "نعم" ✨', ''],
    ],
  }]);
});

test('spools an HTTP upload stream to an isolated temporary file and cleans it up', async () => {
  const upload = Readable.from([Buffer.from('phone,name\n', 'utf8'), Buffer.from('0551234571,ليان\n', 'utf8')]);
  const spooled = await spoolUploadToTempFile(upload, { originalName: 'contacts.csv' });

  assert.equal(path.basename(spooled.filePath), 'upload.csv');
  assert.equal((await fs.readFile(spooled.filePath, 'utf8')), 'phone,name\n0551234571,ليان\n');
  assert.match(path.basename(path.dirname(spooled.filePath)), /^spreadsheet-upload-/);

  await spooled.cleanup();
  await assert.rejects(fs.access(spooled.filePath), { code: 'ENOENT' });
});

test('rejects upload streams above the compressed-byte limit with an application-owned error', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const upload = Readable.from(Array.from({ length: 26 }, () => chunk));

  await assert.rejects(
    spoolUploadToTempFile(upload, { originalName: 'oversized.xlsx' }),
    error => error.code === 'SPREADSHEET_FILE_TOO_LARGE' && error.statusCode === 413,
  );
});

test('uses stable application-owned errors for invalid spreadsheet inputs', async t => {
  const directory = await makeTempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oversizedPath = path.join(directory, 'oversized.xlsx');
  const handle = await fs.open(oversizedPath, 'w');
  await handle.truncate(LIMITS.maxCompressedBytes + 1);
  await handle.close();
  const validXlsx = await makeWorkbook([{ name: 'Audience', rows: [['Phone'], ['0551234567']] }]);

  const cases = [
    {
      name: 'empty',
      input: { source: Buffer.alloc(0), originalName: 'empty.xlsx' },
      code: 'SPREADSHEET_EMPTY',
      statusCode: 400,
    },
    {
      name: 'corrupt ZIP',
      input: { source: Buffer.from('PK\u0003\u0004broken', 'binary'), originalName: 'corrupt.xlsx' },
      code: 'SPREADSHEET_CORRUPT',
      statusCode: 400,
    },
    {
      name: 'oversized compressed file',
      input: { source: oversizedPath, originalName: 'oversized.xlsx' },
      code: 'SPREADSHEET_FILE_TOO_LARGE',
      statusCode: 413,
    },
    {
      name: 'wrong extension',
      input: { source: validXlsx, originalName: 'audience.txt' },
      code: 'SPREADSHEET_UNSUPPORTED_EXTENSION',
      statusCode: 400,
    },
    {
      name: 'non-XLSX content with XLSX extension',
      input: { source: Buffer.from('phone,name\n0551234572,Spoofed', 'utf8'), originalName: 'spoofed.xlsx' },
      code: 'SPREADSHEET_NOT_XLSX',
      statusCode: 400,
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      readSpreadsheet(fixture.input),
      error => error.name === 'SpreadsheetAdapterError'
        && error.code === fixture.code
        && error.statusCode === fixture.statusCode,
      fixture.name,
    );
  }
});

test('rejects workbooks above 50,000 rows across all sheets in workbook order', async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('First');
  const second = workbook.addWorksheet('Second');
  for (let row = 1; row <= 25_000; row += 1) first.addRow([row]);
  for (let row = 1; row <= 25_001; row += 1) second.addRow([row]);
  const input = Buffer.from(await workbook.xlsx.writeBuffer());

  await assert.rejects(
    readSpreadsheet({ source: input, originalName: 'too-many-rows.xlsx' }),
    error => error.code === 'SPREADSHEET_ROW_LIMIT_EXCEEDED'
      && error.statusCode === 422
      && error.details?.maxRows === 50_000,
  );
});

test('writes campaign workbook semantics and presentation without binary comparison', async () => {
  const buffer = await writeSpreadsheetBuffer({
    sheets: [{
      name: 'نموذج الاستهداف',
      rightToLeft: true,
      columns: [
        { header: 'رقم الجوال', key: 'phone', width: 20 },
        { header: 'اسم العميل', key: 'name', width: 24 },
        { header: 'نوع السجل', key: 'status', width: 18 },
      ],
      rows: [
        { phone: '0551234567', name: 'ليان ✨', status: 'طلب' },
        { phone: 551234568, name: 'John Smith', status: 'عميل' },
      ],
      headerBold: true,
      autoFilter: 'A1:C1',
      dataValidations: [{
        range: 'C2:C1000',
        type: 'list',
        allowBlank: true,
        formulae: ['"عميل,طلب,اشتراك"'],
      }],
    }, {
      name: 'التعليمات',
      rightToLeft: true,
      columns: [
        { header: 'الحقل', width: 22 },
        { header: 'الشرح', width: 90 },
      ],
      rows: [['التواريخ', 'استخدم YYYY-MM-DD']],
      headerBold: true,
    }],
  });

  assert.ok(Buffer.isBuffer(buffer));
  const workbook = await captureWorkbook(buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['نموذج الاستهداف', 'التعليمات']);
  const template = workbook.worksheets[0];
  assert.equal(template.views[0].rightToLeft, true);
  assert.deepEqual(template.columns.map(column => column.width), [20, 24, 18]);
  assert.deepEqual(template.getRow(1).values.slice(1), ['رقم الجوال', 'اسم العميل', 'نوع السجل']);
  assert.deepEqual(template.getRow(2).values.slice(1), ['0551234567', 'ليان ✨', 'طلب']);
  assert.deepEqual(template.getRow(3).values.slice(1), [551234568, 'John Smith', 'عميل']);
  assert.deepEqual(
    template.getRow(1).values.slice(1).map((_, index) => Boolean(template.getCell(1, index + 1).font?.bold)),
    [true, true, true],
  );
  assert.equal(template.autoFilter, 'A1:C1');
  const validations = template.dataValidations.model;
  assert.deepEqual(validations.C2, {
    type: 'list',
    formulae: ['"عميل,طلب,اشتراك"'],
    allowBlank: true,
  });
  assert.deepEqual(validations.C1000, validations.C2);
  assert.equal(Object.keys(validations).length, 999);
});

test('preserves Date, decimal, currency, sheet order, and exact row order in exports', async () => {
  const date = new Date('2026-07-26T10:00:00.000Z');
  const buffer = await writeSpreadsheetBuffer({
    sheets: [
      {
        name: 'Payments',
        columns: [
          { header: 'Date', key: 'date', width: 22 },
          { header: 'Amount', key: 'amount', width: 12 },
          { header: 'Currency', key: 'currency', width: 10 },
        ],
        rows: [
          { date, amount: 1750, currency: 'SAR' },
          { date: '2026-07-27', amount: 19.99, currency: 'USD' },
        ],
      },
      { name: 'Empty but present', columns: [{ header: 'Value' }], rows: [] },
    ],
  });

  const readBack = await readSpreadsheet({ source: buffer, originalName: 'export.xlsx' });
  assert.deepEqual(readBack.sheets.map(sheet => sheet.name), ['Payments', 'Empty but present']);
  assert.deepEqual(readBack.sheets[0].rows, [
    ['Date', 'Amount', 'Currency'],
    [date, 1750, 'SAR'],
    ['2026-07-27', 19.99, 'USD'],
  ]);
  assert.deepEqual(readBack.sheets[1].rows, [['Value']]);
});

test('reads and atomically rewrites the billing ledger without losing later rows', async t => {
  const directory = await makeTempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'billing', 'payments-ledger.xlsx');
  const date1 = new Date('2026-07-26T10:00:00.000Z');
  const date2 = new Date('2026-07-27T10:00:00.000Z');
  const workbook = rows => ({
    sheets: [{
      name: 'Payments',
      columns: [
        { header: 'Date', key: 'date', width: 22 },
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Amount', key: 'amount', width: 12 },
        { header: 'Currency', key: 'currency', width: 10 },
      ],
      rows,
    }],
  });

  await writeBillingLedgerAtomic(filePath, workbook([
    { date: date1, name: 'ليان', amount: 1750, currency: 'SAR' },
  ]));
  await writeBillingLedgerAtomic(filePath, workbook([
    { date: date1, name: 'ليان', amount: 1750, currency: 'SAR' },
    { date: date2, name: 'John', amount: 19.99, currency: 'USD' },
  ]));

  const persisted = await readBillingLedger(filePath);
  assert.deepEqual(persisted.sheets[0].rows, [
    ['Date', 'Name', 'Amount', 'Currency'],
    [date1, 'ليان', 1750, 'SAR'],
    [date2, 'John', 19.99, 'USD'],
  ]);
  const siblingNames = await fs.readdir(path.dirname(filePath));
  assert.deepEqual(siblingNames, ['payments-ledger.xlsx']);
});

test('publishes the fixed security limits as adapter-owned constants', () => {
  assert.deepEqual(LIMITS, {
    maxCompressedBytes: 25 * 1024 * 1024,
    maxRows: 50_000,
  });
});
