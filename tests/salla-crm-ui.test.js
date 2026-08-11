'use strict';

// Guard test for the native "سلة" section. It lives INSIDE the dashboard SPA
// (index.html) as a tab, powered by /salla-crm.js — mirroring instagram.js /
// campaigns.js. Locks the wiring (tab button, goTab hook, script include, view
// injection, endpoints) that silently breaks if any piece drifts.
// Visual QA happens on staging.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'dashboard', 'salla-crm.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

test('dashboard has a native "سلة" sidebar tab wired to goTab', () => {
  assert.match(indexHtml, /goTab\('salla'\)/);
  assert.match(indexHtml, /id="tab-salla"/);
  assert.match(indexHtml, /<span class="tab-label">سلة<\/span>/);
});

test('goTab calls the salla init hook (mirrors campaigns/instagram)', () => {
  assert.match(indexHtml, /t==='salla'&&window\.sallaOnTab/);
});

test('index loads the salla script and the server serves it', () => {
  assert.match(indexHtml, /<script src="\/salla-crm\.js">/);
  assert.match(server, /app\.get\('\/salla-crm\.js'/);
  // the off-brand standalone page is gone
  assert.ok(!fs.existsSync(path.join(ROOT, 'dashboard', 'salla-customers.html')));
  assert.doesNotMatch(server, /salla-customers\.html/);
});

test('salla-crm.js injects a native #view-salla, exposes sallaOnTab, and uses platform tokens', () => {
  assert.match(js, /id\s*=\s*'view-salla'/);
  assert.match(js, /window\.sallaOnTab/);
  // platform identity, not the old teal: green tokens + platform button classes
  assert.match(js, /var\(--green\)/);
  assert.match(js, /green-btn/);
  assert.ok(!js.includes('#0fae7e'), 'must not reuse the off-brand teal');
});

test('the script targets every CRM API endpoint it needs', () => {
  for (const ep of ['/status-messages', '/customers', '/audience/count', '/quick-segments', '/crm-status', '/link', '/sync', '/backfill']) {
    assert.ok(js.includes(ep), 'missing endpoint ' + ep);
  }
});
