'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The dashboard "جرب البوت" sandbox confused the owner (2026-06-12): the AI
// said "حولتك للفريق المختص" but nothing reached the group — by design the
// sandbox never sends. It must now SHOW what would have been escalated, and
// never leak the raw [تحويل:...] marker into the preview bubble.

test('test-chat runs prepareEscalation and returns an escalationPreview', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const handlerStart = src.indexOf("'/api/test-chat'");
  const handlerEnd = src.indexOf("'/api/learn-style'");
  const handler = src.slice(handlerStart, handlerEnd);
  assert.match(handler, /prepareEscalation/, 'sandbox must detect the escalation marker');
  assert.match(handler, /escalationPreview/, 'sandbox must expose what would be escalated');
  assert.match(handler, /customerReply/, 'the visible reply must be the marker-stripped customerReply');
});

test('dashboard renders the escalation preview note', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /escalationPreview/, 'dashboard must handle the preview field');
  assert.match(html, /تنبيه التصعيد/, 'preview note must be in plain Arabic');
});
