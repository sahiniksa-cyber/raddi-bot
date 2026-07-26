'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('migration creates tenant-scoped redacted reply traces with retention metadata', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/db/migrations/init.js'),
    'utf8',
  );
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_reply_traces/i);
  for (const field of [
    'operation_id', 'user_id', 'channel_id', 'conversation_id', 'customer_id',
    'selected_product', 'product_context', 'stages', 'prompt_version',
    'validator_version', 'catalog_version', 'retention_until',
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`, 'i'));
  }
  assert.match(source, /INTERVAL '30 days'/i);
  assert.match(source, /idx_ai_reply_traces_retention/i);
});
