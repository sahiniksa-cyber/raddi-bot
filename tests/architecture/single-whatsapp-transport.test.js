'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
} = require('../helpers/source-architecture');

test('only the WhatsApp transport adapter invokes client.sendMessage or sock.sendMessage', () => {
  const violations = findOccurrences(/\b(?:[A-Za-z_$][\w$]*\.)?(?:client|sock)\.sendMessage\s*\(/, {
    allow: ({ relativePath }) => relativePath === 'src/services/whatsapp/whatsapp-transport-adapter.js',
  });

  assert.equal(
    violations.length,
    0,
    `Direct WhatsApp transport calls must move to src/services/whatsapp/whatsapp-transport-adapter.js. Found ${violations.length}:\n${formatOccurrences(violations)}`,
  );
});
