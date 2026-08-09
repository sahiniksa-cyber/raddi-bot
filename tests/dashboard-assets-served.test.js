'use strict';

// Guard: the dashboard references brand images under /assets (e.g. the جواب logo
// in the sidebar and login page). The production server serves dashboard files
// via EXPLICIT routes — not a blanket static root — so a new /assets subdir is
// invisible unless a route is registered. This test locks in that route so the
// logo can never silently 404 in production again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('server registers a static route for /assets (dashboard brand images)', () => {
  assert.ok(
    serverSrc.includes("app.use('/assets', express.static(") && serverSrc.includes("'dashboard/assets'"),
    'src/server.js must serve dashboard/assets at /assets, or the dashboard logo will 404 in production',
  );
});

test('the dashboard logo asset exists on disk', () => {
  const logo = path.join(__dirname, '..', 'dashboard', 'assets', 'logo.png');
  assert.ok(fs.existsSync(logo), 'dashboard/assets/logo.png must exist (referenced by index.html and login.html)');
});

test('the dashboard references the logo via the served /assets path', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(indexHtml, /src="\/assets\/logo\.png"/, 'sidebar logo must point at /assets/logo.png');
});
