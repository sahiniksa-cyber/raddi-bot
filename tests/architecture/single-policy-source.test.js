'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
} = require('../helpers/source-architecture');

test('runtime code has no executable botInstructions policy source outside compatibility and migration boundaries', () => {
  const violations = findOccurrences(/\bbotInstructions\b/, {
    allowOccurrence: ({ relativePath, text }) => relativePath === 'dashboard/index.html'
      && (/botInstr'\)\.value=c\.botInstructions/.test(text)
        || /botInstructions:document\.getElementById\('botInstr'\)/.test(text)),
  });

  assert.equal(
    violations.length,
    0,
    `botInstructions must be confined to dashboard compatibility import/export, the legacy migrator, migration fixtures, tests, and docs. Found ${violations.length}:\n${formatOccurrences(violations)}`,
  );
});
