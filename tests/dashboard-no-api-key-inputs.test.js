'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8'
);

test('customer dashboard has no openaiKeyInput element', () => {
  assert.equal(html.includes('id="openaiKeyInput"'), false);
  assert.equal(html.includes("getElementById('openaiKeyInput')"), false);
});

test('customer dashboard has no googleKeyInput element', () => {
  assert.equal(html.includes('id="googleKeyInput"'), false);
  assert.equal(html.includes("getElementById('googleKeyInput')"), false);
});

test('customer dashboard has no anthropicKeyInput element', () => {
  assert.equal(html.includes('id="anthropicKeyInput"'), false);
  assert.equal(html.includes("getElementById('anthropicKeyInput')"), false);
});

test('customer dashboard has no openrouterKeyInput element', () => {
  assert.equal(html.includes('id="openrouterKeyInput"'), false);
  assert.equal(html.includes("getElementById('openrouterKeyInput')"), false);
});
