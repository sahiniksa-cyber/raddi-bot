'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatOccurrences,
  readSource,
  sourceFiles,
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
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index) - 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index) - 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      index = readQuotedProperty(source, index).end - 1;
      continue;
    }
    if (character === '`') {
      index = readTemplateLiteral(source, index) - 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
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

function readQuotedProperty(source, start) {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      value += source[index + 1] || '';
      index += 1;
    } else if (source[index] === quote) {
      return { value, end: index + 1 };
    } else {
      value += source[index];
    }
  }
  return { value, end: source.length };
}

function skipLineComment(source, start) {
  const newline = source.indexOf('\n', start + 2);
  return newline < 0 ? source.length : newline;
}

function skipBlockComment(source, start) {
  const closing = source.indexOf('*/', start + 2);
  return closing < 0 ? source.length : closing + 2;
}

function readTemplateInterpolation(source, openBrace) {
  let depth = 1;
  for (let index = openBrace + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index) - 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index) - 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      index = readQuotedProperty(source, index).end - 1;
      continue;
    }
    if (character === '`') {
      index = readTemplateLiteral(source, index) - 1;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function readTemplateLiteral(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
    } else if (source[index] === '$' && source[index + 1] === '{') {
      index = readTemplateInterpolation(source, index + 1) - 1;
    } else if (source[index] === '`') {
      return index + 1;
    }
  }
  return source.length;
}

function topLevelObjectProperties(object) {
  const properties = new Set();
  let depth = 0;
  for (let index = 0; index < object.length; index += 1) {
    const character = object[index];
    if (character === '/' && object[index + 1] === '/') {
      index = skipLineComment(object, index) - 1;
      continue;
    }
    if (character === '/' && object[index + 1] === '*') {
      index = skipBlockComment(object, index) - 1;
      continue;
    }
    if (character === '`') {
      index = readTemplateLiteral(object, index) - 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      const quoted = readQuotedProperty(object, index);
      if (depth === 1 && /^\s*:/.test(object.slice(quoted.end))) properties.add(quoted.value);
      index = quoted.end - 1;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;

    let key = null;
    let keyEnd = index;
    if (/[A-Za-z_$]/.test(character)) {
      const keyMatch = object.slice(index).match(/^[A-Za-z_$][\w$]*/);
      key = keyMatch[0];
      keyEnd = index + key.length;
    }
    if (key === null) continue;

    const remainder = object.slice(keyEnd);
    if (/^\s*:/.test(remainder)) properties.add(key);
    index = keyEnd - 1;
  }
  return properties;
}

function hasCompleteGatewayRequest(requests) {
  return requests.some(request => {
    const properties = topLevelObjectProperties(request);
    return REQUIRED_GATEWAY_FIELDS.every(field => properties.has(field));
  });
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

const MULTI_CHARACTER_TOKENS = [
  '>>>=', '===', '!==', '>>>', '**=', '&&=', '||=', '??=', '=>', '==', '!=',
  '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '>>', '**', '...',
];
const EXPRESSION_SEPARATORS = new Set([
  ',', ';', ':', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&=',
  '||=', '??=', '=>',
]);
const CONDITIONAL_EXPRESSION_SEPARATORS = new Set(
  [...EXPRESSION_SEPARATORS].filter(token => token !== ':'),
);

function javascriptTokens(source) {
  const tokens = [];
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/.test(character)) continue;
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index) - 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index) - 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      index = readQuotedProperty(source, index).end - 1;
      continue;
    }
    if (character === '`') {
      index = readTemplateLiteral(source, index) - 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)[0];
      tokens.push({ value: identifier, start: index, end: index + identifier.length, depth });
      index += identifier.length - 1;
      continue;
    }

    if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
    }
    const multiCharacter = MULTI_CHARACTER_TOKENS.find(token => source.startsWith(token, index));
    const value = multiCharacter || character;
    tokens.push({ value, start: index, end: index + value.length, depth });
    if (character === '(' || character === '[' || character === '{') depth += 1;
    index += value.length - 1;
  }
  return tokens;
}

function tokenGroupPairs(tokens) {
  const pairs = new Map();
  const stack = [];
  const closingFor = { '(': ')', '[': ']', '{': '}' };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (closingFor[value]) {
      stack.push({ index, closing: closingFor[value] });
      continue;
    }
    if (![')', ']', '}'].includes(value)) continue;
    const opening = stack.pop();
    if (opening?.closing === value) {
      pairs.set(opening.index, index);
      pairs.set(index, opening.index);
    }
  }
  return pairs;
}

function isConditionalColon(tokens, colonIndex) {
  const depth = tokens[colonIndex].depth;
  let nestedConditionals = 0;
  for (let index = colonIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].depth < depth) break;
    if (tokens[index].depth !== depth) continue;
    if (tokens[index].value === ':') {
      nestedConditionals += 1;
      continue;
    }
    if (tokens[index].value === '?') {
      if (nestedConditionals === 0) return true;
      nestedConditionals -= 1;
      continue;
    }
    if ([',', ';', '='].includes(tokens[index].value)) break;
  }
  return false;
}

function isStaticPropertyKey(tokens, targetIndex, pairs) {
  if (tokens[targetIndex + 1]?.value !== ':') return false;
  if (isConditionalColon(tokens, targetIndex + 1)) return false;
  for (let opening = targetIndex - 1; opening >= 0; opening -= 1) {
    if (tokens[opening].value !== '{') continue;
    const closing = pairs.get(opening);
    if (closing !== undefined && targetIndex < closing) return true;
  }
  return false;
}

function isDestructuringBinding(tokens, targetIndex, pairs) {
  for (let opening = targetIndex - 1; opening >= 0; opening -= 1) {
    if (tokens[opening].value !== '{') continue;
    const closing = pairs.get(opening);
    if (closing === undefined || closing < targetIndex) continue;
    if (
      ['const', 'let', 'var'].includes(tokens[opening - 1]?.value)
      && tokens[closing + 1]?.value === '='
    ) {
      return true;
    }
  }
  return false;
}

function isInControlCondition(tokens, targetIndex, pairs) {
  for (let index = 0; index < targetIndex; index += 1) {
    if (!['if', 'while', 'for'].includes(tokens[index].value)) continue;
    const opening = index + 1;
    if (tokens[opening]?.value !== '(') continue;
    const closing = pairs.get(opening);
    if (closing !== undefined && opening < targetIndex && targetIndex < closing) return true;
  }
  return false;
}

function expressionRangeAtOperator(tokens, operatorIndex, separators) {
  const operatorDepth = tokens[operatorIndex].depth;
  let start = 0;
  let end = tokens.length - 1;

  for (let index = operatorIndex - 1; index >= 0; index -= 1) {
    if (
      tokens[index].depth < operatorDepth
      || (tokens[index].depth === operatorDepth && separators.has(tokens[index].value))
    ) {
      start = index + 1;
      break;
    }
  }
  for (let index = operatorIndex + 1; index < tokens.length; index += 1) {
    if (
      tokens[index].depth < operatorDepth
      || (tokens[index].depth === operatorDepth && separators.has(tokens[index].value))
    ) {
      end = index - 1;
      break;
    }
  }
  return { start, end };
}

function isInLoggerArgument(tokens, targetIndex, operatorIndex, pairs) {
  for (let opening = Math.min(targetIndex, operatorIndex) - 1; opening >= 0; opening -= 1) {
    if (tokens[opening].value !== '(') continue;
    const closing = pairs.get(opening);
    if (
      closing === undefined
      || closing < targetIndex
      || closing < operatorIndex
      || opening > targetIndex
      || opening > operatorIndex
    ) {
      continue;
    }
    const method = tokens[opening - 1];
    const member = tokens[opening - 2];
    const receiver = tokens[opening - 3];
    if (
      /^[A-Za-z_$][\w$]*$/.test(method?.value || '')
      && ['.', '?.'].includes(member?.value)
      && ['logger', 'console'].includes(receiver?.value)
    ) {
      return true;
    }
  }
  return false;
}

function sourceMatchAt(source, token) {
  const lineStart = source.lastIndexOf('\n', token.start - 1) + 1;
  const lineEndIndex = source.indexOf('\n', token.end);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  const line = source.slice(0, token.start).split('\n').length;
  const rawText = source.slice(lineStart, lineEnd).replace(/\r$/, '');
  return {
    line,
    column: token.start - lineStart,
    absoluteIndex: token.start,
    rawText,
    text: rawText.trim(),
    source,
  };
}

function preSendReviewAuthorizationUses() {
  return sourceFiles().flatMap(file => (
    authorizationUsesInSource(file.source)
      .map(match => ({ file: file.relativePath, ...match }))
  ));
}

function isPreSendReviewAuthorizationUse(match, analysis = {}) {
  const tokens = analysis.tokens || javascriptTokens(match.source);
  const targetIndex = tokens.findIndex(token => (
    token.start === match.absoluteIndex && token.value === 'preSendReviewRequired'
  ));
  if (targetIndex < 0) return false;

  const pairs = analysis.pairs || tokenGroupPairs(tokens);
  if (isStaticPropertyKey(tokens, targetIndex, pairs) || isDestructuringBinding(tokens, targetIndex, pairs)) {
    return false;
  }
  if (isInControlCondition(tokens, targetIndex, pairs)) return true;

  return tokens.some((token, operatorIndex) => {
    let separators = null;
    if (token.value === '&&' || token.value === '||') separators = EXPRESSION_SEPARATORS;
    if (token.value === '?') separators = CONDITIONAL_EXPRESSION_SEPARATORS;
    if (separators === null || isInLoggerArgument(tokens, targetIndex, operatorIndex, pairs)) return false;
    const range = expressionRangeAtOperator(tokens, operatorIndex, separators);
    return range.start <= targetIndex && targetIndex <= range.end;
  });
}

function authorizationUsesInSource(source) {
  const tokens = javascriptTokens(source);
  const analysis = { tokens, pairs: tokenGroupPairs(tokens) };
  return tokens
    .filter(token => token.value === 'preSendReviewRequired')
    .map(token => sourceMatchAt(source, token))
    .filter(match => isPreSendReviewAuthorizationUse(match, analysis));
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
  assert.equal(hasCompleteGatewayRequest([
    `{
      metadata: { sendClass: 'reply', policyVersion: 'v1', idempotencyKey: 'id-1', tenantScope: { userId } },
      note: 'sendClass: policyVersion: idempotencyKey: tenantScope:'
      /* sendClass: policyVersion: idempotencyKey: tenantScope: */
    }`,
  ]), false);
  assert.equal(hasCompleteGatewayRequest([
    [
      '{',
      "  note: `sendClass: policyVersion: idempotencyKey: tenantScope: ${{ nested: { tenantScope: 'shadow' } }}`,",
      '}',
    ].join('\n'),
  ]), false);
  assert.equal(hasCompleteGatewayRequest([
    [
      '{',
      "  note: `ignored ${{ nested: { sendClass: 'shadow' } }}`,",
      "  sendClass: 'reply', policyVersion: 'v1', idempotencyKey: 'id-1', tenantScope: { userId },",
      '}',
    ].join('\n'),
  ]), true);
  assert.equal(hasCompleteGatewayRequest([
    [
      '{',
      '  note: `outer ${`sendClass: shadow, policyVersion: shadow, idempotencyKey: shadow, tenantScope: shadow`}`,',
      '}',
    ].join('\n'),
  ]), false);
  assert.equal(hasCompleteGatewayRequest(gatewayRequestObjects(`
    const { WhatsAppSendGateway } = require('./whatsapp-send-gateway');
    WhatsAppSendGateway.send({
      note: \`outer brace } interpolation \${{ nested: \`inner } brace\` }}\`,
      sendClass: 'reply',
      policyVersion: 'v1',
      idempotencyKey: 'id-1',
      tenantScope: { userId },
    });
  `, ['WhatsAppSendGateway'])), true);
});

test('authorization-switch scan catches decision uses while allowing inert compatibility reads', () => {
  const decisions = [
    'if (payload.preSendReviewRequired) allow();',
    'if (!payload.preSendReviewRequired) bypass();',
    'if (Boolean(payload.preSendReviewRequired)) allow();',
    'if (!!payload.preSendReviewRequired) allow();',
    'const reply = payload.preSendReviewRequired ? approved : held;',
    '(payload.preSendReviewRequired) ? approved : held;',
    'payload.preSendReviewRequired && dispatch();',
    '((payload.preSendReviewRequired)) && dispatch();',
    'payload.preSendReviewRequired || hold();',
    '(((payload.preSendReviewRequired))) || hold();',
    'if (payload.preSendReviewRequired === true) allow();',
    'const maySend = enabled && payload.preSendReviewRequired;',
    'const maySend = (enabled && payload.preSendReviewRequired);',
    'const maySend = enabled && (trusted || payload.preSendReviewRequired);',
    'const maySend = enabled ? payload.preSendReviewRequired : false;',
    'const decision = { maySend: enabled ? payload.preSendReviewRequired : false };',
  ];
  for (const decision of decisions) {
    assert.equal(authorizationUsesInSource(decision).length, 1, decision);
  }
  const inertCompatibility = `
    const { preSendReviewRequired } = payload;
    const legacyValue = payload.preSendReviewRequired;
    const groupedLegacyValue = (payload.preSendReviewRequired);
    logger.info({ preSendReviewRequired: payload.preSendReviewRequired });
    logger.info((payload.preSendReviewRequired));
    logger.info(Boolean(enabled && payload.preSendReviewRequired));
    const legacyAlongsideDecision = payload.preSendReviewRequired, maySend = enabled && trusted;
  `;
  assert.equal(authorizationUsesInSource(inertCompatibility).length, 0);
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
