'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('conversation_states table is created, tenant-scoped, with composite FK', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS conversation_states/.test(SRC));
  assert.ok(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(SRC));
  assert.ok(/state\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/.test(SRC));
  assert.ok(/state_version\s+INTEGER NOT NULL DEFAULT 0/.test(SRC));
  assert.ok(/reflects_message_id\s+UUID/.test(SRC));
  assert.ok(/extraction_ok\s+BOOLEAN NOT NULL DEFAULT TRUE/.test(SRC));
  assert.ok(/PRIMARY KEY \(user_id, conversation_id\)/.test(SRC));
  assert.ok(/conversation_states_scope_fk/.test(SRC));
  assert.ok(/REFERENCES conversations \(id, user_id, channel_id, sender\)/.test(SRC));
});
