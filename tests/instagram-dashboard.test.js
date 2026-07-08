'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'instagram.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('index.html has an Instagram tab + view container + script + goTab hook', () => {
  assert.ok(/goTab\(['"]instagram['"]\)/.test(html), 'nav button missing');
  assert.ok(html.includes('id="view-instagram"'), 'view container missing');
  assert.ok(html.includes('id="tab-instagram"'), 'tab id missing');
  assert.ok(html.includes('/instagram.js'), 'script include missing');
  assert.ok(html.includes("t==='instagram'"), 'goTab hook missing');
});

test('server serves /instagram.js', () => {
  assert.ok(serverSrc.includes("app.get('/instagram.js'"), 'static route missing');
});

test('instagram.js loads and saves via the isolated endpoints', () => {
  assert.ok(js.includes('/api/instagram/config'));
  assert.ok(js.includes('/api/instagram/status'));
  assert.ok(js.includes('/api/instagram/conversations'));
  assert.ok(js.includes('igFillForm'));
  assert.ok(js.includes('igSaveConf'));
  assert.ok(js.includes('window.igOnTab'));
});

test('the connect button links to the OAuth start endpoint', () => {
  assert.ok(html.includes('/api/instagram/connect'), 'connect link missing in index.html');
});

test('instagram.js never calls the WhatsApp /api/config endpoint', () => {
  assert.ok(!/['"]\/api\/config['"]/.test(js), 'must not touch WhatsApp config');
});
