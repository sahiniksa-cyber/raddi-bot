'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
  matchingLines,
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
const REQUIRED_GATEWAY_FIELDS = ['sendClass', 'policyVersion', 'idempotencyKey', 'tenantScope'];

function escapeForExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gatewayImportBindings(source) {
  const bindings = new Set();
  const patterns = [
    /(?:const|let|var)\s*\{[^}]*\bWhatsAppSendGateway\b\s*(?::\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*require\s*\(\s*['"][^'"]*whatsapp-send-gateway[^'"]*['"]\s*\)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\([^)]*whatsapp-send-gateway[^)]*\)/g,
    /import\s*\{[^}]*\bWhatsAppSendGateway\b\s*(?:as\s+([A-Za-z_$][\w$]*))?[^}]*\}\s*from\s*/g,
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]*whatsapp-send-gateway[^'"]*['"]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) bindings.add(match[1] || 'WhatsAppSendGateway');
  }
  return [...bindings];
}

function sendReceivers(source, bindings) {
  const receivers = new Set(bindings);
  for (const binding of bindings) {
    const constructor = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapeForExpression(binding)}\\s*\\(`, 'g');
    let match;
    while ((match = constructor.exec(source)) !== null) receivers.add(match[1]);
  }
  return [...receivers];
}

function balancedObjectAt(source, openBrace) {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  return null;
}

function gatewayRequestObjects(source, bindings) {
  const objects = [];
  for (const receiver of sendReceivers(source, bindings)) {
    const invocation = new RegExp(`\\b${escapeForExpression(receiver)}\\s*(?:\\?\\.|\\.)\\s*send\\s*(?:\\?\\.)?\\s*\\(\\s*\\{`, 'g');
    let match;
    while ((match = invocation.exec(source)) !== null) {
      const openBrace = source.indexOf('{', match.index);
      const request = balancedObjectAt(source, openBrace);
      if (request) objects.push(request);
    }
  }
  return objects;
}

function hasCompleteGatewayRequest(requests) {
  return requests.some(request => REQUIRED_GATEWAY_FIELDS.every(field => (
    new RegExp(`\\b${field}\\s*:`).test(request)
  )));
}

function producerGatewayViolations(producer, source) {
  const bindings = gatewayImportBindings(source);
  if (bindings.length === 0) return [`${producer}: missing WhatsAppSendGateway import binding`];
  const requests = gatewayRequestObjects(source, bindings);
  if (requests.length === 0) {
    return [`${producer}: missing invocation of its WhatsAppSendGateway binding`];
  }
  if (!hasCompleteGatewayRequest(requests)) {
    return [`${producer}: missing complete WhatsAppSendGateway request with explicit ${REQUIRED_GATEWAY_FIELDS.join(', ')}`];
  }
  return [];
}

function preSendReviewAuthorizationUses() {
  return findOccurrences(/\bpreSendReviewRequired\b/).filter(isPreSendReviewAuthorizationUse);
}

function isPreSendReviewAuthorizationUse(match) {
  return !/^\s*:/.test(match.rawText.slice(match.column + 'preSendReviewRequired'.length));
}

test('gateway wiring binds the imported gateway and puts every required field in its send request object', () => {
  const valid = `
    const { WhatsAppSendGateway: Gateway } = require('./whatsapp-send-gateway');
    const gateway = new Gateway();
    gateway.send({ sendClass: 'reply', policyVersion: 'v1', idempotencyKey: 'id-1', tenantScope: { userId } });
  `;
  const unrelatedSend = `
    const { WhatsAppSendGateway: Gateway } = require('./whatsapp-send-gateway');
    notifier.send({ sendClass: 'reply', policyVersion: 'v1', idempotencyKey: 'id-1', tenantScope: { userId } });
  `;
  const unrelatedImport = `
    const { WhatsAppSendGateway: Gateway } = require('./not-the-send-gateway');
    const gateway = new Gateway();
    gateway.send({ sendClass: 'reply', policyVersion: 'v1', idempotencyKey: 'id-1', tenantScope: { userId } });
  `;

  assert.deepEqual(producerGatewayViolations('producer.js', valid), []);
  assert.deepEqual(producerGatewayViolations('producer.js', unrelatedSend), [
    'producer.js: missing invocation of its WhatsAppSendGateway binding',
  ]);
  assert.deepEqual(producerGatewayViolations('producer.js', unrelatedImport), [
    'producer.js: missing WhatsAppSendGateway import binding',
  ]);
  assert.ok(hasCompleteGatewayRequest(gatewayRequestObjects(valid, gatewayImportBindings(valid))));
  assert.equal(hasCompleteGatewayRequest([
    '{ sendClass: \'reply\' }',
    '{ policyVersion: \'v1\', idempotencyKey: \'id-1\', tenantScope: { userId } }',
  ]), false);
});

test('authorization-switch scan catches truthy, negated, and coerced preSendReviewRequired reads', () => {
  const uses = [
    'if (payload.preSendReviewRequired) allow();',
    'if (!payload.preSendReviewRequired) bypass();',
    'if (Boolean(payload.preSendReviewRequired)) allow();',
    'if (!!payload.preSendReviewRequired) allow();',
  ];
  for (const use of uses) {
    const [match] = matchingLines(use, /\bpreSendReviewRequired\b/);
    assert.equal(isPreSendReviewAuthorizationUse(match), true, use);
  }
  const [objectKey] = matchingLines('({ preSendReviewRequired: true })', /\bpreSendReviewRequired\b/);
  assert.equal(isPreSendReviewAuthorizationUse(objectKey), false);
});

test('WhatsApp producers invoke WhatsAppSendGateway, never authorize with preSendReviewRequired, and construct complete gateway requests', () => {
  const violations = [];

  for (const producer of PRODUCERS) {
    const source = readSource(producer);
    violations.push(...producerGatewayViolations(producer, source));
  }

  const authorizationSwitches = preSendReviewAuthorizationUses();
  violations.push(...authorizationSwitches.map(match => `${match.file}:${match.line} authorization switch ${match.text}`));

  if (!sourceExists(GATEWAY)) {
    violations.push(`${GATEWAY}: missing WhatsAppSendGateway implementation`);
  }

  assert.equal(
    violations.length,
    0,
    `Every WhatsApp producer must use WhatsAppSendGateway with a complete, tenant-scoped request. Found ${violations.length}:\n${violations.join('\n')}${authorizationSwitches.length ? `\n\nAuthorization-switch source:\n${formatOccurrences(authorizationSwitches)}` : ''}`,
  );
});
