'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

test('migration adds messages_remaining column to billing_accounts', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS messages_remaining INTEGER NOT NULL DEFAULT 0/);
});

test('migration adds quota_expires_at column', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS quota_expires_at TIMESTAMPTZ/);
});

test('migration adds expire_resets_quota column with TRUE default', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS expire_resets_quota BOOLEAN NOT NULL DEFAULT TRUE/);
});

test('migration adds last_topup_amount and last_topup_at columns', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS last_topup_amount INTEGER NOT NULL DEFAULT 0/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ/);
});

test('migration adds idx_billing_accounts_quota index', () => {
  assert.match(migrationSource, /CREATE INDEX IF NOT EXISTS idx_billing_accounts_quota/);
});
