'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('conversations gets a DB-sourced monotonic inbound_seq counter', () => {
  assert.ok(/ALTER TABLE conversations\s+ADD COLUMN IF NOT EXISTS inbound_seq BIGINT NOT NULL DEFAULT 0/.test(SRC));
});

test('messages gets a nullable inbound_seq stamp (no table rewrite)', () => {
  // Nullable, no default → metadata-only ALTER on the large messages table.
  assert.ok(/ALTER TABLE messages\s+ADD COLUMN IF NOT EXISTS inbound_seq BIGINT\b/.test(SRC));
  assert.ok(!/ADD COLUMN IF NOT EXISTS inbound_seq BIGINT NOT NULL/.test(SRC.replace(/conversations[\s\S]*?inbound_seq BIGINT NOT NULL DEFAULT 0/, '')));
});
