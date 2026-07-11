'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'instagram.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('header shows a simple WhatsApp + Instagram channel switcher next to the logo', () => {
  assert.ok(html.includes('class="chan-switch"'), 'channel switcher missing');
  assert.ok(html.includes('id="chan-wa"'), 'WhatsApp channel chip missing');
  assert.ok(html.includes('id="chan-ig"'), 'Instagram channel chip missing');
  assert.ok(html.includes('function selectChannel'), 'selectChannel missing');
  // simple solid brand colours
  assert.ok(html.includes('.chan-wa{background:#25d366}'), 'WhatsApp chip should be solid green');
  assert.ok(html.includes('.chan-ig{background:#d62976}'), 'Instagram chip should be solid pink');
});

test('the channel switcher is hidden until the Instagram feature is enabled', () => {
  // default hidden in markup
  assert.ok(html.includes('class="chan-switch" style="display:none"'), 'switcher should default hidden');
  // revealed by instagram.js only when /api/instagram/status is ok (feature on)
  assert.ok(js.includes('igGateSwitch'), 'gate function missing');
  assert.ok(js.includes("fetch('/api/instagram/status')"), 'gate must check feature status');
});

test('nav tabs drop to their own row, centered', () => {
  assert.ok(html.includes('.nav-tabs{order:10;flex-basis:100%;justify-content:center}'), 'centered second-row rule missing');
});

test('WhatsApp chip goes straight to settings; Instagram chip opens the connect flow', () => {
  assert.ok(html.includes("if(ch==='instagram'){ openInstagram(); } else { goTab('settings'); }"), 'selectChannel routing wrong');
  assert.ok(html.includes('async function openInstagram'), 'openInstagram missing');
  assert.ok(html.includes("/api/instagram/status"), 'openInstagram should check connection status');
});

test('Instagram has a simple connect/activate page (view-instagram)', () => {
  assert.ok(html.includes('id="view-instagram"'), 'view-instagram missing');
  assert.ok(html.includes('ربط وتفعيل إنستقرام'), 'connect page heading missing');
  assert.ok(html.includes('id="igConnectBtn"'), 'connect button missing');
  assert.ok(html.includes('id="igOpenSettingsBtn"'), 'open-settings button missing');
  assert.ok(html.includes('/api/instagram/connect'), 'connect link missing');
});

test('after linking, the SAME WhatsApp settings form opens in Instagram mode', () => {
  assert.ok(html.includes("let settingsChannel = 'whatsapp'"), 'settingsChannel default missing');
  assert.ok(html.includes("'/api/instagram/config'"), 'instagram config endpoint not used by shared form');
  assert.ok(html.includes('id="igCfgBanner"'), 'instagram-mode banner missing');
  assert.ok(html.includes('.ig-cfg .wa-only'), 'wa-only hide rule missing');
  assert.ok(html.includes('function igOpenSettings'), 'igOpenSettings missing');
  assert.ok(html.includes('function exitIgCfgMode'), 'exitIgCfgMode missing');
});

test('Instagram inbox is a panel inside the settings page, shown only in Instagram mode', () => {
  assert.ok(html.includes('class="panel ig-only"'), 'ig-only inbox panel missing');
  assert.ok(html.includes('id="igConvList"'), 'inbox list missing');
  assert.ok(html.includes('.ig-only{display:none}'), 'ig-only hidden by default');
  assert.ok(html.includes('.ig-cfg .ig-only{display:block}'), 'ig-only shown in instagram mode');
});

test('WhatsApp-only panels are tagged wa-only so they hide in Instagram mode', () => {
  assert.ok(html.includes('bot-ctrl wa-only'), 'bot control not tagged');
  assert.ok(html.includes('stats-row wa-only'), 'stats not tagged');
  assert.ok(html.includes('panel wa-only'), 'a whatsapp-only panel not tagged');
});

test('server serves /instagram.js', () => {
  assert.ok(serverSrc.includes("app.get('/instagram.js'"), 'static route missing');
});

test('instagram.js drives the connect page from status and loads the inbox', () => {
  assert.ok(js.includes('/api/instagram/status'));
  assert.ok(js.includes('/api/instagram/conversations'));
  assert.ok(js.includes('igConnectBtn'));
  assert.ok(js.includes('igOpenSettingsBtn'));
  assert.ok(js.includes('function igLoadStatus'));
  assert.ok(js.includes('function igLoadInbox'));
});

test('instagram.js never calls the WhatsApp /api/config endpoint', () => {
  assert.ok(!/['"]\/api\/config['"]/.test(js), 'instagram.js must not touch WhatsApp config');
});
