'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8'
);

test('dashboard does not inline message content into onclick attribute', () => {
  // Any onclick="..." that interpolates ${...content...} is an XSS sink.
  assert.ok(
    !/onclick="[^"]*\$\{[^}]*content[^}]*\}[^"]*"/.test(html),
    'onclick still inlines ${content} — XSS sink'
  );
});

test('dashboard does not inline any template literal into onclick attribute', () => {
  // Stronger: no `onclick="...${...}..."` anywhere — use data-* + delegated listeners.
  assert.ok(
    !/onclick="[^"]*\$\{[^}]*\}[^"]*"/.test(html),
    'onclick contains ${...} interpolation; switch to delegated handler with data-* attrs'
  );
});

test('dashboard copy button uses data-copy-id (not inline content)', () => {
  assert.ok(
    html.includes('data-copy-id="${esc(mid)}"'),
    'cv-bubble-copy must carry data-copy-id'
  );
  assert.ok(
    !/onclick="copyBubble\(/.test(html),
    'copyBubble must not be wired via inline onclick'
  );
});

test('dashboard conversation card uses data-conv-id (not inline id)', () => {
  assert.ok(
    /data-conv-id="\$\{esc\(c\.id\)\}"/.test(html),
    'cv-item must carry data-conv-id'
  );
  assert.ok(
    !/onclick="onConvCardClick\(/.test(html),
    'onConvCardClick must not be wired via inline onclick'
  );
});

test('dashboard resume button uses data-resume-sender (not inline)', () => {
  assert.ok(
    /data-resume-sender="\$\{esc\(p\.sender\)\}"/.test(html),
    'paused-row button must carry data-resume-sender'
  );
  assert.ok(
    !/onclick="resumeChat\(/.test(html),
    'resumeChat must not be wired via inline onclick'
  );
});

test('dashboard installs delegated click listener on document', () => {
  assert.ok(
    /document\.addEventListener\(\s*['"]click['"]/.test(html),
    'expected a delegated click listener bound to document'
  );
});
