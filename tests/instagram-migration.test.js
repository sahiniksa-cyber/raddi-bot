'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const initSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

test('migration declares all instagram_* tables idempotently', () => {
  for (const table of [
    'instagram_accounts',
    'instagram_ai_settings',
    'instagram_conversations',
    'instagram_messages',
    'instagram_logs',
  ]) {
    assert.ok(
      initSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      `missing CREATE TABLE IF NOT EXISTS ${table}`,
    );
  }
});

test('instagram_messages dedup + conversation uniqueness indexes present', () => {
  assert.ok(initSrc.includes('idx_instagram_messages_user_provider_unique'));
  assert.ok(initSrc.includes('idx_instagram_conversations_user_participant'));
});

test('instagram tables never reference whatsapp_sessions', () => {
  // guard: the instagram block must not accidentally FK into whatsapp_sessions
  const block = initSrc.slice(initSrc.indexOf('instagram_accounts'));
  assert.ok(!block.includes('whatsapp_sessions'));
});

test('instagram statements are registered before the statements array closes', () => {
  // the instagram block must live inside the statements array (before migrate())
  const igIdx = initSrc.indexOf('instagram_accounts');
  const migrateIdx = initSrc.indexOf('async function migrate');
  assert.ok(igIdx > 0 && igIdx < migrateIdx, 'instagram block must precede migrate()');
});
