'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Real-looking API keys must never be hard-coded as default text in dashboards.
// Placeholder hints like "sk-proj-..." or "sk-ant-..." are OK (they're short with
// only literal "..." after the prefix). We block any sk-XXXX with 20+ key body chars.

const dashFiles = ['index.html', 'admin.html', 'billing.html', 'login.html', 'admin-login.html'];

test('no hard-coded OpenAI/Anthropic-style key in dashboard HTML', () => {
  for (const f of dashFiles) {
    const fp = path.join(__dirname, '..', 'dashboard', f);
    if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, 'utf8');
    const hits = html.match(/sk-[A-Za-z0-9_\-]{20,}/g) || [];
    assert.equal(
      hits.length,
      0,
      `Found possible hard-coded key in dashboard/${f}: ${hits.join(', ')}`
    );
  }
});

test('admin keys page does not display raw key in value= attribute', () => {
  const fp = path.join(__dirname, '..', 'dashboard', 'admin.html');
  const html = fs.readFileSync(fp, 'utf8');
  // The key inputs must rely on placeholder + masked status text, never value=.
  const matches = html.match(/id="admin[A-Z][a-zA-Z]*KeyInput"[^>]*value=/g);
  assert.equal(matches, null, 'API key input must not pre-fill value=');
});

test('admin keys page reads masked status from server, not raw key', () => {
  const fp = path.join(__dirname, '..', 'dashboard', 'admin.html');
  const html = fs.readFileSync(fp, 'utf8');
  assert.ok(
    /\/api\/admin\/api-keys/.test(html),
    'expected admin to fetch /api/admin/api-keys for masked values'
  );
  assert.ok(
    /محفوظ:\s*\$\{masked\}/.test(html) || /محفوظ:\s*\$\{[a-zA-Z_]+\}/.test(html),
    'expected admin UI to render masked indicator, never the full key'
  );
});
