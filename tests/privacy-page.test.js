'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'privacy.html'), 'utf8');

test('server serves a public /privacy page and /data-deletion', () => {
  assert.ok(serverSrc.includes("app.get('/privacy'"), '/privacy route missing');
  assert.ok(serverSrc.includes("app.get('/data-deletion'"), '/data-deletion route missing');
});

test('privacy page covers the sections Meta expects', () => {
  assert.ok(html.includes('سياسة الخصوصية'), 'title missing');
  assert.ok(html.includes('id="data-deletion"'), 'data-deletion anchor missing');
  assert.ok(/Meta|إنستقرام|واتساب/.test(html), 'must mention the platforms');
  assert.ok(html.includes('support@jwap.net'), 'contact missing');
});
