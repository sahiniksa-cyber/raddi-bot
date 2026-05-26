'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

const aiWorkerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('migration creates escalation_log table with the dedup fields', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS escalation_log/);
  assert.match(migrationSource, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migrationSource, /conversation_id UUID NOT NULL REFERENCES conversations\(id\) ON DELETE CASCADE/);
  assert.match(migrationSource, /contact_target TEXT NOT NULL/);
  assert.match(migrationSource, /sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('migration creates the dedup index on (user_id, conversation_id, contact_target, sent_at DESC)', () => {
  assert.match(
    migrationSource,
    /CREATE INDEX IF NOT EXISTS escalation_log_dedup_idx[\s\S]*?escalation_log[\s\S]*?\(user_id, conversation_id, contact_target, sent_at DESC\)/,
  );
});

test('ai-worker checks the 30-minute cooldown window before enqueuing an escalation', () => {
  assert.match(
    aiWorkerSource,
    /FROM escalation_log[\s\S]*?sent_at > NOW\(\) - INTERVAL '30 minutes'/,
  );
});

test('ai-worker records every escalation it actually enqueues', () => {
  assert.match(
    aiWorkerSource,
    /INSERT INTO escalation_log \(user_id, conversation_id, contact_target\)/,
  );
});

test('ai-worker logs a warning when the cooldown skips an escalation', () => {
  assert.match(aiWorkerSource, /skipping escalation — cooldown active/);
});
