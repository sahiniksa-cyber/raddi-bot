'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

const readExcelFile = require('read-excel-file/node').default;
const writeExcelFile = require('write-excel-file/node').default;
const { Open: openZip } = require('unzipper-esm');
const {
  getOrderOfSiblings,
  getSelfClosingTagMarkup,
  insertElementMarkupAccordingToOrderOfSiblings,
  sanitizeAttributeValue,
  sanitizeTextContent,
} = require('write-excel-file/utility');

const LIMITS = Object.freeze({
  maxCompressedBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxArchiveEntries: 4096,
  maxRows: 50_000,
});

class SpreadsheetAdapterError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = 'SpreadsheetAdapterError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

function adapterError(code, message, statusCode, details) {
  return new SpreadsheetAdapterError(code, message, statusCode, details);
}

function sourceSize(source) {
  if (Buffer.isBuffer(source)) return source.length;
  if (typeof source === 'string') return fs.statSync(source).size;
  throw new TypeError('Spreadsheet source must be a Buffer or file path');
}

async function sourcePrefix(source, byteCount = 4) {
  if (Buffer.isBuffer(source)) return source.subarray(0, byteCount);
  const handle = await fsp.open(source, 'r');
  try {
    const prefix = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(prefix, 0, byteCount, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function extensionFor(originalName) {
  return path.extname(String(originalName || '')).toLowerCase();
}

function enforceSourceLimits(source) {
  const size = sourceSize(source);
  if (size === 0) {
    throw adapterError('SPREADSHEET_EMPTY', 'Spreadsheet file is empty', 400);
  }
  if (size > LIMITS.maxCompressedBytes) {
    throw adapterError(
      'SPREADSHEET_FILE_TOO_LARGE',
      'Spreadsheet file exceeds the 25 MiB compressed-file limit',
      413,
      { maxCompressedBytes: LIMITS.maxCompressedBytes },
    );
  }
}

function rowLimitError(rowsSeen) {
  return adapterError(
    'SPREADSHEET_ROW_LIMIT_EXCEEDED',
    'Spreadsheet exceeds the 50,000-row workbook limit',
    422,
    { maxRows: LIMITS.maxRows, rowsSeen },
  );
}

function enforceRowLimit(sheets) {
  let rowCount = 0;
  for (const sheet of sheets) {
    rowCount += sheet.rows.length;
    if (rowCount > LIMITS.maxRows) throw rowLimitError(rowCount);
  }
  return rowCount;
}

function sourceStream(source) {
  return Buffer.isBuffer(source) ? Readable.from([source]) : fs.createReadStream(source);
}

async function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let pendingQuote = false;
  let firstCharacter = true;
  const decoder = new StringDecoder('utf8');

  function pushRow() {
    const rowsSeen = rows.length + 1;
    if (rowsSeen > LIMITS.maxRows) throw rowLimitError(rowsSeen);
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  }

  function consume(input) {
    let index = 0;
    while (index < input.length) {
      let character = input[index];
      if (firstCharacter) {
        firstCharacter = false;
        if (character === '\uFEFF') {
          index += 1;
          continue;
        }
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (character === '"') {
          field += '"';
          index += 1;
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (character === '"') {
          if (index + 1 === input.length) {
            pendingQuote = true;
            index += 1;
            continue;
          }
          if (input[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          quoted = false;
          index += 1;
          continue;
        }
        field += character;
        index += 1;
        continue;
      }
      if (character === '"' && field.length === 0) {
        quoted = true;
        index += 1;
        continue;
      }
      if (character === ',') {
        row.push(field);
        field = '';
        index += 1;
        continue;
      }
      if (character === '\n' || character === '\r') {
        pushRow();
        if (character === '\r' && input[index + 1] === '\n') index += 1;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
    }
  }

  for await (const chunk of sourceStream(source)) consume(decoder.write(chunk));
  consume(decoder.end());
  if (pendingQuote) {
    pendingQuote = false;
    quoted = false;
  }
  if (quoted) {
    throw adapterError('SPREADSHEET_CORRUPT', 'CSV file contains an unterminated quoted field', 400);
  }
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

function countRowElements(text, beforeIndex = text.length) {
  let count = 0;
  const matcher = /<row(?=[\s>])/g;
  let match;
  while ((match = matcher.exec(text))) {
    if (match.index >= beforeIndex) break;
    count += 1;
  }
  return count;
}

async function countWorksheetRows(worksheetEntries) {
  let rowsSeen = 0;
  let streamedBytes = 0;
  for (const entry of worksheetEntries) {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for await (const chunk of entry.stream()) {
      streamedBytes += chunk.length;
      if (streamedBytes > LIMITS.maxUncompressedBytes) {
        throw adapterError(
          'SPREADSHEET_UNCOMPRESSED_LIMIT_EXCEEDED',
          'Spreadsheet archive exceeds the 256 MiB uncompressed-size limit',
          413,
          { maxUncompressedBytes: LIMITS.maxUncompressedBytes },
        );
      }
      carry += decoder.write(chunk);
      const safeLength = Math.max(0, carry.length - 5);
      rowsSeen += countRowElements(carry, safeLength);
      if (rowsSeen > LIMITS.maxRows) throw rowLimitError(rowsSeen);
      carry = carry.slice(safeLength);
    }
    carry += decoder.end();
    rowsSeen += countRowElements(carry);
    if (rowsSeen > LIMITS.maxRows) throw rowLimitError(rowsSeen);
  }
  return rowsSeen;
}

async function preflightXlsx(source, openZipImpl = openZip) {
  let directory;
  try {
    directory = Buffer.isBuffer(source)
      ? await openZipImpl.buffer(source)
      : await openZipImpl.file(source);
  } catch (error) {
    throw adapterError('SPREADSHEET_CORRUPT', 'XLSX file is corrupt or unreadable', 400, {
      cause: error.message,
    });
  }
  if (directory.files.length > LIMITS.maxArchiveEntries) {
    throw adapterError(
      'SPREADSHEET_ARCHIVE_ENTRY_LIMIT_EXCEEDED',
      'Spreadsheet archive contains too many entries',
      422,
      { maxArchiveEntries: LIMITS.maxArchiveEntries, entriesSeen: directory.files.length },
    );
  }
  let declaredUncompressedBytes = 0;
  for (const entry of directory.files) {
    const entrySize = Number(entry.uncompressedSize);
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
      throw adapterError('SPREADSHEET_CORRUPT', 'XLSX archive has an invalid entry size', 400);
    }
    declaredUncompressedBytes += entrySize;
    if (declaredUncompressedBytes > LIMITS.maxUncompressedBytes) {
      throw adapterError(
        'SPREADSHEET_UNCOMPRESSED_LIMIT_EXCEEDED',
        'Spreadsheet archive exceeds the 256 MiB uncompressed-size limit',
        413,
        { maxUncompressedBytes: LIMITS.maxUncompressedBytes },
      );
    }
  }
  const paths = new Set(directory.files.map(entry => entry.path));
  const worksheetEntries = directory.files.filter(entry => (
    /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(entry.path)
  ));
  if (!paths.has('[Content_Types].xml') || !paths.has('xl/workbook.xml') || worksheetEntries.length === 0) {
    throw adapterError('SPREADSHEET_NOT_XLSX', 'File content is not XLSX', 400);
  }
  return {
    rowCount: await countWorksheetRows(worksheetEntries),
    archiveEntryCount: directory.files.length,
    declaredUncompressedBytes,
  };
}

function createSpreadsheetReader({ readXlsx = readExcelFile, openZipImpl = openZip } = {}) {
  return async function readSpreadsheetWithDependencies({ source, originalName }) {
    const extension = extensionFor(originalName);
    if (extension !== '.xlsx' && extension !== '.csv') {
      throw adapterError(
        'SPREADSHEET_UNSUPPORTED_EXTENSION',
        'Spreadsheet extension is not supported; use CSV or XLSX',
        400,
      );
    }
    enforceSourceLimits(source);

    let sheets;
    if (extension === '.csv') {
      sheets = [{ name: 'sheet1', rows: await parseCsv(source) }];
    } else {
      const signature = await sourcePrefix(source);
      if (!signature.equals(Buffer.from([0x50, 0x4B, 0x03, 0x04]))) {
        throw adapterError('SPREADSHEET_NOT_XLSX', 'File content is not XLSX', 400);
      }
      await preflightXlsx(source, openZipImpl);
      try {
        const parsed = await readXlsx(source, { trim: false });
        sheets = parsed.map(sheet => ({ name: sheet.sheet, rows: sheet.data }));
      } catch (error) {
        throw adapterError('SPREADSHEET_CORRUPT', 'XLSX file is corrupt or unreadable', 400, {
          cause: error.message,
        });
      }
    }

    if (!sheets.length || sheets.every(sheet => sheet.rows.length === 0)) {
      throw adapterError('SPREADSHEET_EMPTY', 'Spreadsheet contains no used cells', 400);
    }
    return { sheets, rowCount: enforceRowLimit(sheets) };
  };
}

const readSpreadsheet = createSpreadsheetReader();

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('Temporary upload file made no write progress');
    }
    offset += bytesWritten;
  }
}

function createUploadSpooler({ fsOps = fsp, tempRoot = os.tmpdir() } = {}) {
  return async function spoolUpload(stream, { originalName }) {
    const extension = extensionFor(originalName);
    let directory;
    let handle;
    let filePath;
    let byteLength = 0;
    try {
      directory = await fsOps.mkdtemp(path.join(tempRoot, 'spreadsheet-upload-'));
      filePath = path.join(directory, `upload${extension || '.bin'}`);
      handle = await fsOps.open(filePath, 'wx');
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.length;
        if (byteLength > LIMITS.maxCompressedBytes) {
          throw adapterError(
            'SPREADSHEET_FILE_TOO_LARGE',
            'Spreadsheet file exceeds the 25 MiB compressed-file limit',
            413,
            { maxCompressedBytes: LIMITS.maxCompressedBytes },
          );
        }
        await writeAll(handle, buffer);
      }
      await handle.close();
      handle = null;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (directory) await fsOps.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return {
      filePath,
      byteLength,
      cleanup: () => fsOps.rm(directory, { recursive: true, force: true }),
    };
  };
}

const spoolUploadToTempFile = createUploadSpooler();

function cellForWrite(value, { bold = false } = {}) {
  const cell = { value: value === undefined ? null : value };
  if (value instanceof Date) {
    cell.type = Date;
    cell.format = 'yyyy-mm-dd hh:mm:ss';
  }
  if (bold) cell.fontWeight = 'bold';
  return cell;
}

function sheetDataForWrite(sheet) {
  const columns = sheet.columns || [];
  const header = columns.map(column => cellForWrite(column.header ?? '', { bold: sheet.headerBold }));
  const rows = (sheet.rows || []).map(row => {
    const values = Array.isArray(row)
      ? row
      : columns.map(column => row?.[column.key]);
    return values.map(value => cellForWrite(value));
  });
  return [header, ...rows];
}

function assertCellRange(value, fieldName) {
  const range = String(value || '');
  if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(range)) {
    throw new TypeError(`${fieldName} must be an A1 cell or cell range`);
  }
  return range;
}

function spreadsheetPresentationFeature() {
  return {
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform(xml, sheetOptions) {
            const siblingOrder = getOrderOfSiblings(
              'xl/worksheets/sheet{id}.xml',
              'worksheet',
            );
            if (sheetOptions.autoFilter) {
              const autoFilter = getSelfClosingTagMarkup('autoFilter', {
                ref: assertCellRange(sheetOptions.autoFilter, 'autoFilter'),
              });
              xml = insertElementMarkupAccordingToOrderOfSiblings(
                xml,
                autoFilter,
                siblingOrder,
                'worksheet',
              );
            }
            if (sheetOptions.dataValidations?.length) {
              const rules = sheetOptions.dataValidations.map(validation => {
                if (validation.type !== 'list') {
                  throw new TypeError(`Unsupported data validation type: ${validation.type}`);
                }
                const formulae = validation.formulae || [];
                if (formulae.length !== 1) {
                  throw new TypeError('List data validation requires exactly one formula');
                }
                const attributes = [
                  `type="${sanitizeAttributeValue(validation.type)}"`,
                  `allowBlank="${validation.allowBlank ? 1 : 0}"`,
                  `sqref="${sanitizeAttributeValue(assertCellRange(validation.range, 'data validation range'))}"`,
                ].join(' ');
                return `<dataValidation ${attributes}><formula1>${sanitizeTextContent(String(formulae[0]))}</formula1></dataValidation>`;
              }).join('');
              const dataValidations = `<dataValidations count="${sheetOptions.dataValidations.length}">${rules}</dataValidations>`;
              xml = insertElementMarkupAccordingToOrderOfSiblings(
                xml,
                dataValidations,
                siblingOrder,
                'worksheet',
              );
            }
            return xml;
          },
        },
      },
    },
  };
}

async function writeSpreadsheetBuffer(workbook) {
  if (!workbook?.sheets?.length) {
    throw new TypeError('Spreadsheet workbook requires at least one sheet');
  }
  const sheets = workbook.sheets.map(sheet => ({
    data: sheetDataForWrite(sheet),
    sheet: sheet.name,
    rightToLeft: Boolean(sheet.rightToLeft),
    columns: (sheet.columns || []).map(column => ({ width: column.width })),
    autoFilter: sheet.autoFilter,
    dataValidations: sheet.dataValidations,
  }));
  return Buffer.from(await writeExcelFile(sheets, {
    features: [spreadsheetPresentationFeature()],
  }).toBuffer());
}

async function readBillingLedger(filePath) {
  return readSpreadsheet({ source: filePath, originalName: filePath });
}

async function writeBillingLedgerAtomic(filePath, workbook) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    const buffer = await writeSpreadsheetBuffer(workbook);
    handle = await fsp.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
}

module.exports = {
  LIMITS,
  SpreadsheetAdapterError,
  createSpreadsheetReader,
  createUploadSpooler,
  readSpreadsheet,
  spoolUploadToTempFile,
  writeSpreadsheetBuffer,
  readBillingLedger,
  writeBillingLedgerAtomic,
};
