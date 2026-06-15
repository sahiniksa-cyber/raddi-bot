'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { statements } = require('../src/db/migrations/init');

test('a migration switches Gemini/empty bot_configs to gpt-4o', () => {
  const stmt = statements.find(s => /UPDATE\s+bot_configs/i.test(s) && /gpt-4o/.test(s));
  assert.ok(stmt, 'expected an UPDATE bot_configs … gpt-4o migration statement');
  // sets config.model to gpt-4o
  assert.match(stmt, /jsonb_set\(\s*config\s*,\s*'\{model\}'/);
  // targets empty AND google/Gemini models only (leaves other explicit models alone)
  assert.match(stmt, /COALESCE\(\s*config->>'model'/);
  assert.match(stmt, /google\/%/);
});
