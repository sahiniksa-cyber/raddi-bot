'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function dashboardHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
}

test('every named inline dashboard control resolves to an implemented function', () => {
  const html = dashboardHtml();
  const dashboardDir = path.join(__dirname, '..', 'dashboard');
  const externalScripts = fs.readdirSync(dashboardDir)
    .filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(dashboardDir, file), 'utf8'))
    .join('\n');
  const code = `${html}\n${externalScripts}`;
  const languageKeywords = new Set(['if', 'return', 'void']);
  const handlers = [...html.matchAll(/on(?:click|change|input|submit|keydown)="\s*([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1])
    .filter(name => !languageKeywords.has(name));

  assert.ok(new Set(handlers).size >= 60, 'expected broad dashboard control coverage');
  for (const handler of new Set(handlers)) {
    const escaped = handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const implemented = new RegExp(`function\\s+${escaped}\\s*\\(`).test(code)
      || new RegExp(`(?:window\\.)?${escaped}\\s*=\\s*(?:async\\s*)?\\(?`).test(code);
    assert.equal(implemented, true, `missing dashboard handler: ${handler}`);
  }
});

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

test('dashboard exposes the ownerPauseMinutes setting (input + load + save) and paused panel', () => {
  const html = dashboardHtml();
  // Input element
  assert.match(html, /id="ownerPauseMinutes"/);
  // Loaded from config (default 30)
  assert.match(html, /getElementById\('ownerPauseMinutes'\)\.value=c\.ownerPauseMinutes/);
  // Persisted in the save payload
  assert.match(html, /ownerPauseMinutes:\(\(\)=>\{const v=parseInt\(document\.getElementById\('ownerPauseMinutes'\)/);
  // Paused-chats panel wired to the real endpoint
  assert.match(html, /id="pausedPanel"/);
  assert.match(html, /fetch\('\/api\/paused-chats'\)/);
  assert.match(html, /fetch\('\/api\/paused-chats\/resume'/);
});

test('dashboard shows the message quota panel', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /رصيد الرسائل/);
  assert.match(html, /id="quotaRemaining"/);
  assert.match(html, /id="quotaTopupBtn"/);
});
