'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function dashboardHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
}

test('dashboard exposes conversations as a top-level tab', () => {
  const html = dashboardHtml();

  assert.match(html, /id="tab-conversations"/);
  assert.match(html, /id="view-conversations"/);
  assert.match(html, /onclick="goTab\('conversations'\)"/);
});

test('conversation list rendering wires the core helpers', () => {
  const html = dashboardHtml();

  assert.match(html, /renderConversationList/);
  assert.match(html, /selectConversation/);
  assert.match(html, /filterConversations/);
  // WhatsApp-style redesign (post-2026-05-26) — vertical list of cv-item rows with colored avatars and unread badges.
  assert.match(html, /cv-item/);
  assert.match(html, /cv-item-avatar/);
  assert.match(html, /avatarGradient/);
});

test('escalation template variables are clickable insert buttons', () => {
  const html = dashboardHtml();

  assert.match(html, /function insertEscVariable/);
  assert.match(html, /onclick="insertEscVariable\(this,'\{\{customerPhone\}\}'\)"/);
  assert.match(html, /onclick="insertEscVariable\(this,'\{\{customerMessage\}\}'\)"/);
  assert.match(html, /onclick="insertEscVariable\(this,'\{\{summary\}\}'\)"/);
});

test('dashboard does not auto restart WhatsApp from passive polling', () => {
  const html = dashboardHtml();
  const match = html.match(/function maybeRecoverStuckConnecting\(d\)\{([\s\S]*?)\n\}/);

  assert.ok(match, 'maybeRecoverStuckConnecting exists');
  assert.doesNotMatch(match[1], /\/api\/bot\/restart/);
});

test('dashboard does not show the legacy cost panel', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /إجمالي التكلفة/);
  assert.doesNotMatch(html, /id="costTotal"/);
});

test('dashboard shows the message quota panel', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /رصيد الرسائل/);
  assert.match(html, /id="quotaRemaining"/);
  assert.match(html, /id="quotaTopupBtn"/);
});
