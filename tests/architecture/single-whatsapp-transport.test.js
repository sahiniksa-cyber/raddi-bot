'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
} = require('../helpers/source-architecture');

const DIRECT_WHATSAPP_SEND_PATTERNS = [
  /\b(?:client|sock)\s*(?:\?\.|\.)\s*sendMessage\s*(?:\?\.)?\s*\(/,
  /\b(?:client|sock)\s*(?:(?:\?\.)\s*)?\[\s*['"]sendMessage['"]\s*\]\s*(?:\?\.)?\s*\(/,
  /\[\s*['"](?:client|sock)['"]\s*\]\s*(?:\?\.|\.)\s*sendMessage\s*(?:\?\.)?\s*\(/,
  /\[\s*['"](?:client|sock)['"]\s*\]\s*(?:(?:\?\.)\s*)?\[\s*['"]sendMessage['"]\s*\]\s*(?:\?\.)?\s*\(/,
];

test('transport boundary detects dotted, optional, spaced, and bracket direct-call variants', () => {
  const variants = [
    'client.sendMessage(message)',
    'sock?.sendMessage?.(message)',
    'client . sendMessage (message)',
    "client ['sendMessage'] (message)",
    "bot?.['sock']?.['sendMessage']?.(message)",
  ];

  for (const variant of variants) {
    assert.ok(DIRECT_WHATSAPP_SEND_PATTERNS.some(pattern => pattern.test(variant)), variant);
  }
});

test('only the WhatsApp transport adapter invokes client.sendMessage or sock.sendMessage', () => {
  const violations = DIRECT_WHATSAPP_SEND_PATTERNS.flatMap(pattern => findOccurrences(pattern, {
    allow: ({ relativePath }) => relativePath === 'src/services/whatsapp/whatsapp-transport-adapter.js',
  }));

  assert.equal(
    violations.length,
    0,
    `Direct WhatsApp transport calls must move to src/services/whatsapp/whatsapp-transport-adapter.js. Found ${violations.length}:\n${formatOccurrences(violations)}`,
  );
});
