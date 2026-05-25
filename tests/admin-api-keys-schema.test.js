'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('init.js declares admin_api_keys table with provider PK and api_key column', () => {
  const initSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
    'utf8'
  );
  assert.match(initSrc, /CREATE TABLE IF NOT EXISTS admin_api_keys/i);
  assert.match(initSrc, /provider\s+TEXT\s+PRIMARY KEY/i);
  assert.match(initSrc, /api_key\s+TEXT\s+NOT NULL/i);
  assert.match(initSrc, /updated_at\s+TIMESTAMPTZ/i);
  assert.match(initSrc, /updated_by\s+UUID/i);
  assert.match(initSrc, /CREATE TRIGGER trg_admin_api_keys_updated_at/i);
});
