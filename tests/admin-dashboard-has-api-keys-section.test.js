'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'admin.html'),
  'utf8'
);

test('admin dashboard contains an api-keys section', () => {
  assert.match(html, /id="adminApiKeysSection"|class="admin-api-keys"/);
});

test('admin dashboard has inputs for all four providers', () => {
  assert.match(html, /id="adminOpenaiKeyInput"/);
  assert.match(html, /id="adminGoogleKeyInput"/);
  assert.match(html, /id="adminAnthropicKeyInput"/);
  assert.match(html, /id="adminOpenrouterKeyInput"/);
});

test('admin dashboard calls GET /api/admin/api-keys somewhere', () => {
  assert.ok(
    html.includes('/api/admin/api-keys'),
    'expected admin.html to reference /api/admin/api-keys endpoint'
  );
});
