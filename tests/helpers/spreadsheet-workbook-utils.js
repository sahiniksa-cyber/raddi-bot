'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { Open: openZip } = require('unzipper-esm');

const {
  readSpreadsheet,
  writeSpreadsheetBuffer,
} = require('../../src/services/spreadsheets/spreadsheet-adapter');

function columnName(index) {
  let value = index;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlAttributes(markup) {
  const attributes = {};
  for (const match of String(markup || '').matchAll(/\s([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1].split(':').at(-1)] = decodeXml(match[2]);
  }
  return attributes;
}

function semanticValue(value) {
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  return value;
}

function semanticText(value) {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value === null || value === undefined) return '';
  return String(value);
}

function rowSemantics(rows) {
  return rows.map((row, rowIndex) => ({
    row: rowIndex + 1,
    cells: row.map((value, columnIndex) => ({
      address: `${columnName(columnIndex + 1)}${rowIndex + 1}`,
      column: columnIndex + 1,
      value: semanticValue(value),
      text: semanticText(value),
    })),
  }));
}

function workbookFromRows(sheets) {
  return writeSpreadsheetBuffer({
    sheets: sheets.map(sheet => {
      const rows = sheet.rows || [];
      const headers = rows[0] || [];
      return {
        name: sheet.name,
        rightToLeft: sheet.rightToLeft,
        columns: headers.map((header, index) => ({
          header,
          key: `c${index}`,
          width: sheet.widths?.[index],
        })),
        rows: rows.slice(1).map(row => Object.fromEntries(headers.map((_, index) => [`c${index}`, row[index]]))),
        headerBold: sheet.headerBold,
        autoFilter: sheet.autoFilter,
        dataValidations: sheet.dataValidations,
      };
    }),
  });
}

async function zipDirectory(source) {
  return Buffer.isBuffer(source) ? openZip.buffer(source) : openZip.file(source);
}

async function entryText(directory, entryPath) {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const entry = directory.files.find(file => file.path.replace(/\\/g, '/') === normalized);
  if (!entry) return '';
  const chunks = [];
  for await (const chunk of entry.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function relationshipTargets(relationshipsXml) {
  const targets = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attributes = xmlAttributes(match[0]);
    if (attributes.Id && attributes.Target) {
      targets.set(attributes.Id, attributes.Target.replace(/^\.\.\//, ''));
    }
  }
  return targets;
}

async function worksheetXmlBySheet(directory) {
  const workbookXml = await entryText(directory, 'xl/workbook.xml');
  const relsXml = await entryText(directory, 'xl/_rels/workbook.xml.rels');
  const targets = relationshipTargets(relsXml);
  const worksheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const attributes = xmlAttributes(match[0]);
    const target = targets.get(attributes.id);
    if (!target) continue;
    worksheets.push({
      name: attributes.name,
      xml: await entryText(directory, path.posix.join('xl', target).replace(/\\/g, '/')),
    });
  }
  return worksheets;
}

function boldStyleIds(stylesXml) {
  const fonts = [...stylesXml.matchAll(/<font\b[^>]*>[\s\S]*?<\/font>/g)].map(match => /<b\b/.test(match[0]));
  const ids = new Set();
  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/)?.[0] || '';
  let index = 0;
  for (const match of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
    const attributes = xmlAttributes(match[0]);
    if (fonts[Number(attributes.fontId || 0)]) ids.add(index);
    index += 1;
  }
  return ids;
}

function worksheetPresentation(xml, stylesXml, columnCount) {
  const sheetView = xml.match(/<sheetView\b[^>]*>/)?.[0] || '';
  const columns = Array.from({ length: columnCount }, () => null);
  for (const match of xml.matchAll(/<col\b[^>]*>/g)) {
    const attributes = xmlAttributes(match[0]);
    const min = Number(attributes.min);
    const max = Number(attributes.max);
    const width = attributes.width === undefined ? null : Number(attributes.width);
    for (let index = min; index <= max; index += 1) columns[index - 1] = width;
  }
  const autoFilter = xmlAttributes(xml.match(/<autoFilter\b[^>]*>/)?.[0] || '').ref || null;
  const boldIds = boldStyleIds(stylesXml);
  const headerBold = [];
  for (const match of xml.matchAll(/<c\b[^>]*r="([A-Z]+)1"[^>]*>/g)) {
    const attributes = xmlAttributes(match[0]);
    headerBold.push(boldIds.has(Number(attributes.s || 0)));
  }
  const validations = [];
  for (const match of xml.matchAll(/<dataValidation\b[^>]*>[\s\S]*?<\/dataValidation>/g)) {
    const attributes = xmlAttributes(match[0]);
    const formula = decodeXml(match[0].match(/<formula1>([\s\S]*?)<\/formula1>/)?.[1] || '');
    validations.push({ attributes, formula });
  }
  const expandedValidations = [];
  for (const validation of validations) {
    const range = validation.attributes.sqref || '';
    const rangeMatch = range.match(/^([A-Z]+)(\d+):\1(\d+)$/);
    if (rangeMatch) {
      const [, column, start, end] = rangeMatch;
      for (let row = Number(start); row <= Number(end); row += 1) {
        expandedValidations.push({
          address: `${column}${row}`,
          validation: {
            type: validation.attributes.type,
            formulae: [validation.formula],
            allowBlank: validation.attributes.allowBlank === '1' || validation.attributes.allowBlank === 'true',
          },
        });
      }
    }
  }
  return {
    rightToLeft: /rightToLeft="1"|rightToLeft="true"/.test(sheetView),
    columnWidths: columns,
    autoFilter,
    headerBold,
    dataValidation: expandedValidations.length
      ? {
          count: expandedValidations.length,
          first: expandedValidations[0],
          last: expandedValidations.at(-1),
        }
      : null,
  };
}

async function workbookSemantics(source, originalName = 'workbook.xlsx', { allowEmptyWorkbook = true } = {}) {
  const workbook = await readSpreadsheet({ source, originalName, allowEmptyWorkbook });
  if (String(originalName).toLowerCase().endsWith('.csv')) {
    return {
      sheetOrder: workbook.sheets.map(sheet => sheet.name),
      sheets: workbook.sheets.map(sheet => ({
        name: sheet.name,
        presentation: {
          rightToLeft: false,
          columnWidths: [],
          autoFilter: null,
          headerBold: [],
          dataValidation: null,
        },
        rows: rowSemantics(sheet.rows),
      })),
    };
  }
  const directory = await zipDirectory(source);
  const worksheets = await worksheetXmlBySheet(directory);
  const stylesXml = await entryText(directory, 'xl/styles.xml');
  return {
    sheetOrder: workbook.sheets.map(sheet => sheet.name),
    sheets: workbook.sheets.map((sheet, index) => ({
      name: sheet.name,
      presentation: worksheetPresentation(
        worksheets[index]?.xml || '',
        stylesXml,
        Math.max(0, ...sheet.rows.map(row => row.length)),
      ),
      rows: rowSemantics(sheet.rows),
    })),
  };
}

async function workbookSemanticsFromFile(filePath, options) {
  const buffer = await fs.readFile(filePath);
  return workbookSemantics(buffer, filePath, options);
}

module.exports = {
  workbookFromRows,
  workbookSemantics,
  workbookSemanticsFromFile,
};
