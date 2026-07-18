'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_CONFIG } = require('../lib/constants');
const {
  isAutomatedCustomerReply,
  isAutoReplyEnabled,
} = require('../src/services/bot/auto-reply-control');

const root = path.join(__dirname, '..');

test('auto-reply is on by default for existing merchants', () => {
  assert.equal(DEFAULT_CONFIG.autoReplyEnabled, true);
  assert.equal(isAutoReplyEnabled({}), true);
  assert.equal(isAutoReplyEnabled({ autoReplyEnabled: false }), false);
});

test('auto-reply switch covers bot replies but never campaigns or manual sends', () => {
  for (const source of ['ai_reply', 'ai_failure_fallback', 'auto_reply_keyword']) {
    assert.equal(isAutomatedCustomerReply({ source }), true, source);
  }
  assert.equal(isAutomatedCustomerReply({ kind: 'quota_stop' }), true);
  assert.equal(isAutomatedCustomerReply({ source: 'campaign' }), false);
  assert.equal(isAutomatedCustomerReply({ source: 'manual_send' }), false);
  assert.equal(isAutomatedCustomerReply({ escalation: true }), false);
});

test('dashboard offers an explicit reply-only switch and explains campaigns stay connected', () => {
  const html = fs.readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /id="connectedAutoReplyBtn"[^>]+toggleBotAutoReply/);
  assert.match(html, /id="ctrlAutoReplyBtn"[^>]+toggleBotAutoReply/);
  assert.match(html, /إيقاف الرد لا يفصل واتساب؛ الحملات والرسائل اليدوية تستمر/);
  assert.match(html, /\/api\/bot\/auto-reply/);
  assert.match(html, /واتساب بقي متصلاً والحملات مستمرة/);
  assert.doesNotMatch(html, /id="connectedAutoReplyBtn"[^>]+botStop/);
});

test('backend mounts a dedicated auto-reply endpoint without changing campaign delivery', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'bot.routes.js'), 'utf8');
  const campaignWorker = fs.readFileSync(path.join(root, 'src', 'workers', 'campaign-worker.js'), 'utf8');
  assert.match(server, /post\('\/api\/bot\/auto-reply'/);
  assert.match(routes, /post\('\/api\/bot\/auto-reply', controller\.setAutoReply\)/);
  assert.doesNotMatch(campaignWorker, /autoReplyEnabled|auto-reply-control/);
});

test('empty merchant knowledge no longer blocks AI generation or final sending', () => {
  const aiWorker = fs.readFileSync(path.join(root, 'src', 'workers', 'ai-worker.js'), 'utf8');
  const outgoingWorker = fs.readFileSync(
    path.join(root, 'src', 'workers', 'outgoing-whatsapp-worker.js'),
    'utf8',
  );
  assert.doesNotMatch(aiWorker, /merchantKnowledgeReadiness|missing_merchant_knowledge/);
  assert.doesNotMatch(outgoingWorker, /merchantKnowledgeReadiness|missing_merchant_knowledge/);
});
