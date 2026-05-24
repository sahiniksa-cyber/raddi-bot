'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

test('conversations view uses two-pane structure with cv-shell', () => {
  assert.match(html, /id="view-conversations"/);
  assert.match(html, /class="cv-shell"/);
  assert.match(html, /id="cvList"/);
  assert.match(html, /id="cvPanel"/);
  assert.match(html, /id="cvSearch"/);
});

test('conversations view no longer has the old tab buttons', () => {
  assert.doesNotMatch(html, /class="conv-tabs"/);
  assert.doesNotMatch(html, /setConvFilter/);
  assert.doesNotMatch(html, /id="convTabAll"/);
});

test('conversations view links the conversations.css stylesheet', () => {
  assert.match(html, /href="conversations\.css"/);
});

test('conversations view has empty/placeholder state in panel', () => {
  assert.match(html, /id="cvPanelEmpty"/);
});
