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
const MAX_CONTROL_PART_BYTES = 1024 * 1024;
const CONTENT_TYPES_PART = '[Content_Types].xml';
const WORKBOOK_PART = 'xl/workbook.xml';
const WORKBOOK_RELATIONSHIPS_PART = 'xl/_rels/workbook.xml.rels';
const WORKSHEET_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

let saxenModulePromise;

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
  let pendingCarriageReturn = false;
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
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (character === '\n') {
          index += 1;
          continue;
        }
      }
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
        pendingCarriageReturn = character === '\r';
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

async function loadSaxenParser() {
  saxenModulePromise ||= import('saxen');
  const { Parser } = await saxenModulePromise;
  return Parser;
}

function localXmlName(name) {
  const separator = String(name).lastIndexOf(':');
  return separator === -1 ? String(name) : String(name).slice(separator + 1);
}

function attributeByLocalName(attributes, expectedName) {
  const match = Object.entries(attributes).find(
    ([name]) => localXmlName(name).toLowerCase() === expectedName.toLowerCase(),
  );
  return match?.[1];
}

function normalizeOoxmlPartPath(partName, relationshipSourcePath = '') {
  const rawPartName = String(partName || '').replaceAll('\\', '/');
  const sourcePath = String(relationshipSourcePath || '').replaceAll('\\', '/');
  const combined = rawPartName.startsWith('/')
    ? rawPartName.slice(1)
    : path.posix.join(path.posix.dirname(sourcePath), rawPartName);
  const normalized = path.posix.normalize(combined);
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    throw adapterError('SPREADSHEET_CORRUPT', 'XLSX archive contains an invalid part path', 400);
  }
  return normalized;
}

function createStreamingXmlParser(Parser, onOpenTag) {
  const parser = new Parser();
  let parseError;
  const rememberError = error => {
    parseError ||= error;
  };
  parser.on('error', rememberError);
  parser.on('warn', rememberError);
  parser.on('openTag', onOpenTag);
  return {
    write(text) {
      parser.write(text);
      if (parseError) throw parseError;
    },
    end() {
      const endError = parser.end();
      if (parseError || endError) throw parseError || endError;
    },
  };
}

function uncompressedLimitError() {
  return adapterError(
    'SPREADSHEET_UNCOMPRESSED_LIMIT_EXCEEDED',
    'Spreadsheet archive exceeds the 256 MiB uncompressed-size limit',
    413,
    { maxUncompressedBytes: LIMITS.maxUncompressedBytes },
  );
}

function corruptSpreadsheetError(error) {
  if (error instanceof SpreadsheetAdapterError) return error;
  return adapterError('SPREADSHEET_CORRUPT', 'XLSX file is corrupt or unreadable', 400, {
    cause: error?.message || String(error),
  });
}

async function streamArchiveEntries(directory, Parser) {
  const entryByPath = new Map();
  for (const entry of directory.files) {
    const normalizedPath = normalizeOoxmlPartPath(`/${entry.path}`);
    if (entryByPath.has(normalizedPath)) {
      throw adapterError('SPREADSHEET_CORRUPT', 'XLSX archive contains duplicate part paths', 400);
    }
    entryByPath.set(normalizedPath, entry);
  }

  const workbookRelationshipIds = [];
  const workbookRelationshipIdSet = new Set();
  const relationshipIds = new Set();
  const worksheetRelationshipTargets = new Map();
  const controlParts = new Map();

  function addControlPart(partPath, onOpenTag) {
    if (!entryByPath.has(partPath)) return;
    controlParts.set(partPath, {
      bytes: 0,
      decoder: new StringDecoder('utf8'),
      parser: createStreamingXmlParser(Parser, onOpenTag),
    });
  }

  addControlPart(CONTENT_TYPES_PART, () => {});
  addControlPart(WORKBOOK_PART, (name, getAttributes) => {
    if (localXmlName(name).toLowerCase() !== 'sheet') return;
    const attributes = getAttributes();
    if (!attributeByLocalName(attributes, 'name')) return;
    const relationshipId = attributeByLocalName(attributes, 'id');
    if (!relationshipId) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook sheet is missing its relationship ID',
        400,
      );
    }
    if (workbookRelationshipIdSet.has(relationshipId)) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook contains duplicate sheet relationship IDs',
        400,
      );
    }
    workbookRelationshipIdSet.add(relationshipId);
    workbookRelationshipIds.push(relationshipId);
  });
  addControlPart(WORKBOOK_RELATIONSHIPS_PART, (name, getAttributes) => {
    if (localXmlName(name).toLowerCase() !== 'relationship') return;
    const attributes = getAttributes();
    const relationshipId = attributeByLocalName(attributes, 'Id');
    const relationshipType = attributeByLocalName(attributes, 'Type');
    const relationshipTarget = attributeByLocalName(attributes, 'Target');
    if (!relationshipId || !relationshipType || !relationshipTarget) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook contains a malformed relationship',
        400,
      );
    }
    if (relationshipIds.has(relationshipId)) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook contains duplicate relationship IDs',
        400,
      );
    }
    relationshipIds.add(relationshipId);
    if (relationshipType === WORKSHEET_RELATIONSHIP_TYPE) {
      worksheetRelationshipTargets.set(
        relationshipId,
        normalizeOoxmlPartPath(relationshipTarget, WORKBOOK_PART),
      );
    }
  });

  let actualUncompressedBytes = 0;
  for (const entry of directory.files) {
    const normalizedPath = normalizeOoxmlPartPath(`/${entry.path}`);
    const controlPart = controlParts.get(normalizedPath);
    for await (const chunk of entry.stream()) {
      actualUncompressedBytes += chunk.length;
      if (actualUncompressedBytes > LIMITS.maxUncompressedBytes) {
        throw uncompressedLimitError();
      }
      if (controlPart) {
        controlPart.bytes += chunk.length;
        if (controlPart.bytes > MAX_CONTROL_PART_BYTES) {
          throw adapterError(
            'SPREADSHEET_CORRUPT',
            'XLSX control part exceeds the safe parsing limit',
            400,
          );
        }
        controlPart.parser.write(controlPart.decoder.write(chunk));
      }
    }
    if (controlPart) {
      controlPart.parser.write(controlPart.decoder.end());
      controlPart.parser.end();
    }
  }

  return {
    entryByPath,
    workbookRelationshipIds,
    worksheetRelationshipTargets,
    actualUncompressedBytes,
  };
}

async function countWorksheetRows(worksheetEntries, Parser) {
  let rowsSeen = 0;
  for (const entry of worksheetEntries) {
    const decoder = new StringDecoder('utf8');
    const parser = createStreamingXmlParser(Parser, name => {
      if (localXmlName(name).toLowerCase() !== 'row') return;
      rowsSeen += 1;
      if (rowsSeen > LIMITS.maxRows) throw rowLimitError(rowsSeen);
    });
    for await (const chunk of entry.stream()) parser.write(decoder.write(chunk));
    parser.write(decoder.end());
    parser.end();
  }
  return rowsSeen;
}

async function preflightXlsxInternal(source, openZipImpl) {
  const directory = Buffer.isBuffer(source)
    ? await openZipImpl.buffer(source)
    : await openZipImpl.file(source);
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
      throw uncompressedLimitError();
    }
  }

  const Parser = await loadSaxenParser();
  const {
    entryByPath,
    workbookRelationshipIds,
    worksheetRelationshipTargets,
    actualUncompressedBytes,
  } = await streamArchiveEntries(directory, Parser);
  if (!entryByPath.has(CONTENT_TYPES_PART)) {
    throw adapterError('SPREADSHEET_NOT_XLSX', 'File content is not XLSX', 400);
  }
  if (
    !entryByPath.has(WORKBOOK_PART)
    || !entryByPath.has(WORKBOOK_RELATIONSHIPS_PART)
    || workbookRelationshipIds.length === 0
  ) {
    throw adapterError('SPREADSHEET_CORRUPT', 'XLSX workbook relationships are missing', 400);
  }
  const worksheetEntries = [];
  const worksheetPartPaths = new Set();
  for (const relationshipId of workbookRelationshipIds) {
    const worksheetPartPath = worksheetRelationshipTargets.get(relationshipId);
    if (!worksheetPartPath) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook sheet relationship is missing',
        400,
      );
    }
    if (worksheetPartPaths.has(worksheetPartPath)) {
      throw adapterError(
        'SPREADSHEET_CORRUPT',
        'XLSX workbook contains duplicate worksheet targets',
        400,
      );
    }
    worksheetPartPaths.add(worksheetPartPath);
    const entry = entryByPath.get(worksheetPartPath);
    if (!entry) {
      throw adapterError('SPREADSHEET_CORRUPT', 'XLSX worksheet part is missing', 400);
    }
    worksheetEntries.push(entry);
  }
  return {
    rowCount: await countWorksheetRows(worksheetEntries, Parser),
    archiveEntryCount: directory.files.length,
    declaredUncompressedBytes,
    actualUncompressedBytes,
  };
}

async function preflightXlsx(source, openZipImpl = openZip) {
  try {
    return await preflightXlsxInternal(source, openZipImpl);
  } catch (error) {
    throw corruptSpreadsheetError(error);
  }
}

function createSpreadsheetReader({ readXlsx = readExcelFile, openZipImpl = openZip } = {}) {
  return async function readSpreadsheetWithDependencies({
    source,
    originalName,
    allowEmptyWorkbook = false,
  }) {
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

    if (!allowEmptyWorkbook && (!sheets.length || sheets.every(sheet => sheet.rows.length === 0))) {
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
  // write-excel-file treats "" as a missing cell. A NUL sentinel is non-empty
  // to its shared-string registry but is stripped by its XML sanitizer, which
  // yields the explicit empty shared string that ExcelJS writes and reopens.
  const cell = { value: value === '' ? '\0' : (value === undefined ? null : value) };
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
  return readSpreadsheet({
    source: filePath,
    originalName: filePath,
    allowEmptyWorkbook: true,
  });
}

async function writeBillingLedgerAtomic(filePath, workbook, { fsOps = fsp } = {}) {
  const directory = path.dirname(filePath);
  await fsOps.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    const buffer = await writeSpreadsheetBuffer(workbook);
    handle = await fsOps.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsOps.rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsOps.rm(temporaryPath, { force: true }).catch(() => {});
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
