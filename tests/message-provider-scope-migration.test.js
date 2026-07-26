'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('provider message uniqueness is tenant and channel scoped', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/db/migrations/init.js'),
    'utf8',
  );
  assert.match(source, /DROP INDEX IF EXISTS idx_messages_user_provider_message_unique/);
  assert.match(
    source,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_scope_provider_message_unique[\s\S]+user_id,\s*channel_id,\s*provider_message_id/i,
  );
});
