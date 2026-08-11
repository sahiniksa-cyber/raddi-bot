'use strict';

// Guard test for the Customer-Intelligence page. The dashboard is served by
// EXPLICIT file routes (not a static root), so a new page silently 404s unless
// both the file exists AND the route is registered — this locks both down.
// (Visual QA happens on staging; this guards the wiring that has bitten before.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('page + script files exist', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard', 'salla-customers.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard', 'salla-crm.js')));
});

test('server registers explicit routes for the page and its script', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/salla-customers'/);
  assert.match(server, /app\.get\('\/salla-crm\.js'/);
});

test('the page has the Salla-branded hub with all three tabs + mount points', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'salla-customers.html'), 'utf8');
  assert.match(html, /src="\/salla-crm\.js"/);
  assert.match(html, /dir="rtl"/);
  // three tabs
  assert.match(html, /data-pane="messages"/);
  assert.match(html, /data-pane="connect"/);
  assert.match(html, /data-pane="customers"/);
  // mount points
  assert.match(html, /id="statusList"/);
  assert.match(html, /id="rows"/);
  assert.match(html, /id="quick"/);
  assert.match(html, /id="drawer"/);
  assert.match(html, /id="syncProgress"/);
});

test('the script targets every CRM API endpoint it needs', () => {
  const js = fs.readFileSync(path.join(ROOT, 'dashboard', 'salla-crm.js'), 'utf8');
  for (const ep of ['/api/salla/quick-segments', '/api/salla/customers', '/api/salla/audience/count',
    '/api/salla/status-messages', '/api/salla/crm-status', '/api/salla/link', '/api/salla/sync', '/api/salla/backfill']) {
    assert.ok(js.includes(ep), 'missing endpoint ' + ep);
  }
});
