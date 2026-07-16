'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

const tabs = ['connect', 'conversations', 'campaigns', 'train', 'settings', 'pricing', 'instagram', 'account'];

test('dashboard uses a responsive right-side navigation shell', () => {
  assert.ok(html.includes('id="mainSidebar"'));
  assert.ok(html.includes('id="sidebarOverlay"'));
  assert.ok(html.includes('id="mainMenuBtn"'));
  assert.ok(html.includes('id="dashboardApp"'));
  assert.ok(html.includes('body.nav-mobile-open .main-sidebar'));
  assert.ok(html.includes('body.nav-collapsed .main-sidebar'));
  assert.ok(html.includes('@media(max-width:999px)'));
});

test('all existing navigation contracts remain unique and connected to their views', () => {
  for (const tab of tabs) {
    assert.equal((html.match(new RegExp(`id="tab-${tab}"`, 'g')) || []).length, 1, `tab-${tab} must stay unique`);
    assert.equal((html.match(new RegExp(`id="view-${tab}"`, 'g')) || []).length, 1, `view-${tab} must stay unique`);
    assert.ok(html.includes(`onclick="goTab('${tab}')"`), `${tab} navigation action missing`);
  }
});

test('navigation is grouped by merchant task and no longer rendered in the topbar', () => {
  assert.ok(html.includes('class="nav-section-label">العمل اليومي'));
  assert.ok(html.includes('class="nav-section-label">الذكاء والتخصيص'));
  assert.ok(html.includes('class="nav-section-label">الحساب والمنصة'));
  const topbar = html.split('<div class="topbar">')[1].split('</div>\n\n<!-- Storage warning')[0];
  assert.doesNotMatch(topbar, /class="nav-tabs"/);
});

test('hamburger, mobile drawer and active page title are wired without replacing goTab', () => {
  assert.ok(html.includes('function toggleMainNav()'));
  assert.ok(html.includes('function closeMobileNav()'));
  assert.ok(html.includes('function updateNavigationChrome('));
  assert.ok(html.includes('updateNavigationChrome(t);'));
  assert.ok(html.includes("event.key==='Escape'"));
  assert.ok(html.includes("lucide.createIcons({ attrs: { 'stroke-width': 1.5 } })"));
});

test('inline dashboard scripts remain syntactically valid', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
});
