'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

test('migration creates immutable tenant-scoped product catalog versions', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS product_catalog_versions/i);
  assert.match(source, /user_id UUID NOT NULL REFERENCES users\(id\)/i);
  assert.match(source, /version BIGINT NOT NULL/i);
  assert.match(source, /products JSONB NOT NULL/i);
  assert.match(source, /previous_products JSONB NOT NULL/i);
  assert.match(source, /changed_by TEXT NOT NULL/i);
  assert.match(source, /change_reason TEXT/i);
  assert.match(source, /UNIQUE\s*\(user_id,\s*version\)/i);
  assert.match(source, /prevent_product_catalog_version_mutation/i);
});

