'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { buildPlatformPromptBlock } = require('../src/services/bot/platform-features');
const { DEFAULT_CONFIG } = require('../lib/constants');

// ---- defaults ----
test('DEFAULT_CONFIG carries the new escalation/owner-pause options with safe defaults', () => {
  assert.equal(DEFAULT_CONFIG.escalationPausesBot, false);
  assert.equal(DEFAULT_CONFIG.ownerPausePhraseMode, false);
  assert.equal(DEFAULT_CONFIG.maxEscalationsPerConversation, 5);
  assert.deepEqual(DEFAULT_CONFIG.ownerPausePhrases, []);
});

// ---- owner-pause phrase mode ----
function ingestWith(mode, phrases) {
  const db = {
    isConfigured: () => true,
    query: async () => ({ rows: [{ mode: String(mode), phrases: phrases ?? null }] }),
  };
  return new MessageIngestService({ logger: { info() {}, warn() {} }, database: db });
}

test('phrase mode OFF → any owner reply pauses', async () => {
  const svc = ingestWith('false', null);
  assert.equal(await svc.shouldOwnerReplyPause('u1', 'اي رسالة عادية'), true);
});

test('phrase mode ON → pauses only when the reply contains a trigger phrase', async () => {
  const svc = ingestWith('true', ['خليني ارد', 'انا بكمل']);
  assert.equal(await svc.shouldOwnerReplyPause('u1', 'تمام خليني أرد على هذا العميل'), true);
  assert.equal(await svc.shouldOwnerReplyPause('u1', 'صباح الخير كيف الحال'), false);
});

test('phrase mode ON but no phrases configured → does not pause', async () => {
  const svc = ingestWith('true', []);
  assert.equal(await svc.shouldOwnerReplyPause('u1', 'اي شي'), false);
});

// ---- escalation conditions injected into the prompt ----
test('buildPlatformPromptBlock injects merchant escalation conditions when set', () => {
  const block = buildPlatformPromptBlock({ escalationConditions: 'لو العميل غاضب أو طلب استرجاع' }, {});
  assert.match(block, /صعّد للمختص/);
  assert.match(block, /لو العميل غاضب أو طلب استرجاع/);
});

test('buildPlatformPromptBlock omits the escalation line when no conditions set', () => {
  const block = buildPlatformPromptBlock({}, {});
  assert.doesNotMatch(block, /صعّد للمختص \(بكتابة علامة التحويل\)/);
});

// ---- ai-worker: escalation pause is optional + cap is configurable (source-level) ----
const aiWorkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
const outgoingWorkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');

test('escalation pause is applied ONLY when config.escalationPausesBot is true', () => {
  assert.match(aiWorkerSrc, /if \(config\.escalationPausesBot === true\)/);
  // the unconditional 30-min mute is gone
  assert.doesNotMatch(aiWorkerSrc, /SET escalated_until = NOW\(\) \+ INTERVAL '30 minutes'/);
});

test('re-escalation cap uses config.maxEscalationsPerConversation (not a hardcoded 3)', () => {
  assert.match(aiWorkerSrc, /config\.maxEscalationsPerConversation/);
  assert.match(aiWorkerSrc, /effectiveMaxEsc > 0 && escStats\.count24h >= effectiveMaxEsc/);
});

test('customer handoff acknowledgement is identified in the outgoing payload', () => {
  assert.match(aiWorkerSrc, /handoffAcknowledgement:\s*Boolean\(escalation\.ownerMessage\)/);
});

test('normal and lid sends ignore only the acknowledgement own escalation pause', () => {
  const wiring = outgoingWorkerSrc.match(
    /ignoreEscalationPause:\s*payload\.handoffAcknowledgement\s*===\s*true/g,
  ) || [];
  // Two guards per send path: the start-of-job guard AND the send-boundary
  // re-check (closes the manual-reply race during the pre-send window). Normal
  // path (2) + @lid path (2) = 4.
  assert.equal(wiring.length, 4);
});
