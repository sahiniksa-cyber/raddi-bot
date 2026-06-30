'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('init migration creates prompt_edit_requests idempotently with the expected columns', () => {
  assert.match(src, /CREATE TABLE IF NOT EXISTS prompt_edit_requests/);
  for (const col of [
    'user_id', 'source_jid', 'requester_jid', 'request_text',
    'current_instructions', 'proposed_instructions', 'change_summary',
    'status', 'created_at', 'decided_at',
  ]) {
    assert.ok(src.includes(col), `prompt_edit_requests must define column ${col}`);
  }
});
