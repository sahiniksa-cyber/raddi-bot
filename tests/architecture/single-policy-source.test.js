'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findOccurrences,
  formatOccurrences,
  matchingLines,
} = require('../helpers/source-architecture');

test('source scanner counts every matching token on one line', () => {
  assert.equal(matchingLines('botInstructions + botInstructions', /\bbotInstructions\b/).length, 2);
});

test('runtime code has no executable botInstructions policy source outside compatibility and migration boundaries', () => {
  const violations = findOccurrences(/\bbotInstructions\b/, {
    allowOccurrence: ({ relativePath, text }) => (
      relativePath === 'src/policy/merchant-policy-migrator.js'
      || (relativePath === 'dashboard/index.html'
        && (/botInstr'\)\.value=c\.botInstructions/.test(text)
          || /botInstructions:document\.getElementById\('botInstr'\)/.test(text)))
    ),
  });

  assert.equal(
    violations.length,
    0,
    `botInstructions must be confined to dashboard compatibility import/export, the legacy migrator, migration fixtures, tests, and docs. Found ${violations.length}:\n${formatOccurrences(violations)}`,
  );
});
