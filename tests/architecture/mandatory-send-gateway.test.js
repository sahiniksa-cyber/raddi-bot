'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
  readSource,
  sourceExists,
} = require('../helpers/source-architecture');

const GATEWAY = 'src/services/whatsapp/whatsapp-send-gateway.js';
const PRODUCERS = [
  'src/controllers/bot.controller.js',
  'src/workers/campaign-worker.js',
  'src/workers/outgoing-whatsapp-worker.js',
  'src/services/monitoring/alerts.js',
  'src/services/monitoring/unlink-alert.js',
];

test('WhatsApp producers invoke WhatsAppSendGateway, never authorize with preSendReviewRequired, and construct complete gateway requests', () => {
  const violations = [];

  for (const producer of PRODUCERS) {
    const source = readSource(producer);
    if (!/WhatsAppSendGateway/.test(source)) violations.push(`${producer}: missing WhatsAppSendGateway import`);
    if (!/\.send\s*\(/.test(source)) violations.push(`${producer}: missing WhatsAppSendGateway invocation`);
  }

  const authorizationSwitches = findOccurrences(/\bpreSendReviewRequired\b\s*(?:!==|===|!=|==)\s*(?:true|false)/);
  violations.push(...authorizationSwitches.map(match => `${match.file}:${match.line} authorization switch ${match.text}`));

  if (!sourceExists(GATEWAY)) {
    violations.push(`${GATEWAY}: missing WhatsAppSendGateway request construction`);
  } else {
    const source = readSource(GATEWAY);
    for (const field of ['sendClass', 'policyVersion', 'idempotencyKey', 'tenantScope']) {
      if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
        violations.push(`${GATEWAY}: missing explicit ${field}`);
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Every WhatsApp producer must use WhatsAppSendGateway with a complete, tenant-scoped request. Found ${violations.length}:\n${violations.join('\n')}${authorizationSwitches.length ? `\n\nAuthorization-switch source:\n${formatOccurrences(authorizationSwitches)}` : ''}`,
  );
});
