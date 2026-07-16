const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pages = [
  'dashboard/index.html',
  'dashboard/login.html',
  'dashboard/billing.html',
  'dashboard/terms.html',
  'dashboard/privacy.html',
  'dashboard/admin.html',
  'dashboard/admin-login.html',
];
const fontStylesheet = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;600&display=swap';

test('all dashboard pages load and use the exact Noto Sans Arabic design font', () => {
  for (const file of pages) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, new RegExp(fontStylesheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /(?:font-family|--font):\s*['"]Noto Sans Arabic['"]/);
  }
});

test('content security policy allows the Noto stylesheet and font files', () => {
  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(server, /styleSrc:[^\n]+https:\/\/fonts\.googleapis\.com/);
  assert.match(server, /fontSrc:[^\n]+https:\/\/fonts\.gstatic\.com/);
});
