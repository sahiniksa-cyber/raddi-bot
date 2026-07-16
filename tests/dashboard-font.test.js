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
const fontStylesheet = '/fatima-font.css';

test('all dashboard pages load and use the original Fatima Arabic font', () => {
  for (const file of pages) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, new RegExp(fontStylesheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /(?:font-family|--font):\s*['"]Fatima['"]/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|Noto Sans Arabic/);
  }
});

test('Fatima font is self-hosted with every original weight', () => {
  const css = fs.readFileSync(path.join(root, 'dashboard/fatima-font.css'), 'utf8');
  for (const weight of [300, 400, 500, 700, 900]) assert.match(css, new RegExp(`font-weight:${weight}`));
  assert.equal((css.match(/@font-face/g) || []).length, 5);
  assert.match(css, /Fatimah Arabic Regular\.otf/);
  assert.match(css, /Fatimah Arabic Balck\.otf/);
});

test('server serves Fatima locally and no longer allows external Google fonts', () => {
  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(server, /app\.get\('\/fatima-font\.css'/);
  assert.doesNotMatch(server, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});
