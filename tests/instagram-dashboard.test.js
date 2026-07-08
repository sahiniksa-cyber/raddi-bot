'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'instagram.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('header shows a WhatsApp + Instagram channel switcher next to the logo', () => {
  assert.ok(html.includes('class="chan-switch"'), 'channel switcher missing');
  assert.ok(html.includes('id="chan-wa"'), 'WhatsApp channel chip missing');
  assert.ok(html.includes('id="chan-ig"'), 'Instagram channel chip missing');
  assert.ok(html.includes('function selectChannel'), 'selectChannel missing');
  // both chips carry a distinctive brand background
  assert.ok(html.includes('.chan-wa{background'), 'WhatsApp chip style missing');
  assert.ok(html.includes('.chan-ig{background'), 'Instagram chip style missing');
});

test('index.html has a distinctive Instagram tab + view + script + goTab hook', () => {
  assert.ok(/goTab\(['"]instagram['"]\)/.test(html), 'nav button missing');
  assert.ok(html.includes('id="view-instagram"'), 'view container missing');
  assert.ok(html.includes('id="tab-instagram"'), 'tab id missing');
  assert.ok(html.includes('/instagram.js'), 'script include missing');
  assert.ok(html.includes("t==='instagram'"), 'goTab hook missing');
});

test('nav tabs drop to their own row under the header', () => {
  assert.ok(html.includes('.nav-tabs{order:10;flex-basis:100%}'), 'tabs-second-row rule missing');
});

test('instagram connection + inbox live inside the settings page as ig-only panels', () => {
  assert.ok(html.includes('panel ig-only ig-connect'), 'IG connect panel missing');
  assert.ok(html.includes('id="igConvList"'), 'inbox list missing (should be in settings page)');
  assert.ok(html.includes('.ig-only{display:none}'), 'ig-only hidden by default');
  assert.ok(html.includes('.ig-cfg .ig-only{display:block}'), 'ig-only shown in instagram mode');
  // The old custom instagram view is now an empty stub (no duplicate ids).
  assert.ok(html.includes('<div class="view" id="view-instagram"><div class="sw"></div></div>'), 'view-instagram should be an empty stub');
});

test('selecting the Instagram channel opens the shared settings page', () => {
  assert.ok(html.includes("if(ch==='instagram'){ igOpenSettings(); }"), 'instagram chip should open settings');
});

test('settings form is reused for Instagram via a channel switch (true parity)', () => {
  assert.ok(html.includes("let settingsChannel = 'whatsapp'"), 'settingsChannel default missing');
  assert.ok(html.includes("'/api/instagram/config'"), 'instagram config endpoint not used by shared form');
  assert.ok(html.includes('id="igCfgBanner"'), 'instagram-mode banner missing');
  assert.ok(html.includes('.ig-cfg .wa-only'), 'wa-only hide rule missing');
  assert.ok(html.includes('function igOpenSettings'), 'igOpenSettings missing');
  assert.ok(html.includes('function exitIgCfgMode'), 'exitIgCfgMode missing');
});

test('WhatsApp-only panels are tagged wa-only so they hide in Instagram mode', () => {
  assert.ok(html.includes('bot-ctrl wa-only'), 'bot control not tagged');
  assert.ok(html.includes('stats-row wa-only'), 'stats not tagged');
  assert.ok(html.includes('panel wa-only'), 'a whatsapp-only panel not tagged');
});

test('server serves /instagram.js', () => {
  assert.ok(serverSrc.includes("app.get('/instagram.js'"), 'static route missing');
});

test('instagram.js uses the isolated endpoints and gates until linked', () => {
  assert.ok(js.includes('/api/instagram/status'));
  assert.ok(js.includes('/api/instagram/conversations'));
  assert.ok(js.includes('function igApplyGate'));
  assert.ok(js.includes('ig-hidden'));
  assert.ok(js.includes('igLoadStatus'));
});

test('instagram.js never calls the WhatsApp /api/config endpoint', () => {
  assert.ok(!/['"]\/api\/config['"]/.test(js), 'instagram.js must not touch WhatsApp config');
});

test('the connect button links to the OAuth start endpoint', () => {
  assert.ok(html.includes('/api/instagram/connect'), 'connect link missing in index.html');
});
