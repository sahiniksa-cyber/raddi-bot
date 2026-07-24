'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadHistory } = require('../src/workers/ai-history');
const { getProfile } = require('../src/workers/profile-extractor');
const { findDuplicateRecentReply } = require('../src/workers/reply-deduplication');

test('AI history rejects a read without tenant scope', async () => {
  let calls = 0;
  const database = { query: async () => { calls++; return { rows: [] }; } };
  await assert.rejects(
    loadHistory(database, 'conversation-1', 10),
    /userId.*required/i,
  );
  assert.equal(calls, 0);
});

test('customer profile and reply dedup never query without tenant scope', async () => {
  let calls = 0;
  const database = {
    isConfigured: () => true,
    query: async () => { calls++; return { rows: [{ content: 'secret' }] }; },
  };

  assert.equal(await getProfile({ database, conversationId: 'conversation-1' }), null);
  assert.equal(await findDuplicateRecentReply({
    db: database,
    conversationId: 'conversation-1',
    candidate: 'secret',
  }), null);
  assert.equal(calls, 0);
});

test('message schema binds tenant and customer to the referenced conversation', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
    'utf8',
  );
  assert.match(migration, /UNIQUE\s*\(id,\s*user_id,\s*channel_id,\s*sender\)/i);
  assert.match(migration, /ALTER COLUMN conversation_id SET NOT NULL/i);
  assert.match(
    migration,
    /FOREIGN KEY\s*\(conversation_id,\s*user_id,\s*channel_id,\s*sender\)\s*REFERENCES conversations\s*\(id,\s*user_id,\s*channel_id,\s*sender\)/i,
  );
});
