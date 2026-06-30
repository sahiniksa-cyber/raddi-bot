'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'config.routes.js'), 'utf8');
const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'config.controller.js'), 'utf8');

test('config routes expose GET /api/prompt-edits', () => {
  assert.match(routesSrc, /get\(\s*['"]\/api\/prompt-edits['"]/);
});

test('config controller defines listPromptEdits', () => {
  assert.match(ctrlSrc, /listPromptEdits/);
});

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

test('dashboard has the prompt-edit enable toggle', () => {
  assert.match(htmlSrc, /id=["']pe_enabled["']/);
});

test('dashboard saves and loads whatsappPromptEditEnabled', () => {
  assert.match(htmlSrc, /whatsappPromptEditEnabled/);
});

test('dashboard fetches the prompt-edit log endpoint', () => {
  assert.match(htmlSrc, /\/api\/prompt-edits/);
});
