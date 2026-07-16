'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiWorker = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
const outgoingWorker = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');

test('every AI-worker customer-reply source opts into final pre-send review', () => {
  for (const source of ['auto_reply_keyword', 'ai_reply', 'ai_failure_fallback']) {
    const sourceIndex = aiWorker.indexOf(`source: '${source}'`);
    assert.ok(sourceIndex >= 0, `${source} payload exists`);
    const payloadTail = aiWorker.slice(sourceIndex, sourceIndex + 180);
    assert.match(payloadTail, /preSendReviewRequired:\s*true/, `${source} requires final review`);
  }
});

test('normal and @lid paths review before their WhatsApp send calls', () => {
  const normalStart = outgoingWorker.indexOf('async function processOutgoingWhatsapp');
  const lidStart = outgoingWorker.indexOf('async function handleLidOutgoing');
  const normalBlock = outgoingWorker.slice(normalStart, lidStart);
  const lidBlock = outgoingWorker.slice(lidStart, outgoingWorker.indexOf('async function completeSuppressedOutgoing'));

  assert.ok(normalBlock.indexOf('await reviewBeforeSend') < normalBlock.indexOf('await sendWhatsappReply'));
  assert.ok(lidBlock.indexOf('await reviewBeforeSend') < lidBlock.indexOf('bot.client.sendMessage(sender, finalReply)'));
  assert.doesNotMatch(normalBlock, /sendWhatsappReply\([^\n]*reply, providerMessageId/,
    'normal path must not send the unreviewed payload variable');
  assert.doesNotMatch(lidBlock, /sendMessage\(sender, reply\)/,
    '@lid path must not send the unreviewed payload variable');
});
