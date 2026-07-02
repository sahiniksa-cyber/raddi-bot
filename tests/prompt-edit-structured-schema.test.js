'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('prompt_edit_requests gains target + proposed_value columns (idempotent)', () => {
  assert.match(src, /ALTER TABLE prompt_edit_requests\s+ADD COLUMN IF NOT EXISTS target TEXT/);
  assert.match(src, /ALTER TABLE prompt_edit_requests\s+ADD COLUMN IF NOT EXISTS proposed_value JSONB/);
});
