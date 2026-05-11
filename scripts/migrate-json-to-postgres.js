'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('../src/db/client');
const { migrate } = require('../src/db/migrations/init');

const DEFAULT_CONFIG = require('../lib/constants').DEFAULT_CONFIG;

function dataRoot() {
  return path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd());
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function normalizeUuid(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

async function userDirectories(root) {
  const dirs = new Set();

  for (const base of [path.join(root, 'data'), root]) {
    let entries = [];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && normalizeUuid(entry.name)) {
        dirs.add(path.join(base, entry.name));
      }
    }
  }

  return [...dirs];
}

async function upsertUser(client, user) {
  const id = normalizeUuid(user.id);
  if (!id) return null;

  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;

  const passwordHash = user.password || user.passwordHash || await bcrypt.hash('temporary-password-change-me', 12);
  const name = String(user.name || email.split('@')[0] || '').trim();
  const role = user.role || 'user';

  await client.query(
    `INSERT INTO users (id, email, name, password_hash, role, email_verified, legacy_payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, NOW()))
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       legacy_payload = EXCLUDED.legacy_payload`,
    [
      id,
      email,
      name,
      passwordHash,
      role,
      user.emailVerified !== false,
      JSON.stringify(user),
      user.createdAt || null,
    ],
  );

  return id;
}

async function upsertConfig(client, userId, config) {
  const payload = { ...DEFAULT_CONFIG, ...(config || {}) };
  await client.query(
    `INSERT INTO bot_configs (user_id, config, source)
     VALUES ($1, $2::jsonb, 'json-migration')
     ON CONFLICT (user_id) DO UPDATE SET
       config = EXCLUDED.config,
       source = EXCLUDED.source`,
    [userId, JSON.stringify(payload)],
  );
}

async function upsertSession(client, userId, userDir) {
  const sessionPath = path.join(userDir, 'session');
  await client.query(
    `INSERT INTO whatsapp_sessions (user_id, status, session_path, auth_state)
     VALUES ($1, 'stopped', $2, '{}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       session_path = EXCLUDED.session_path`,
    [userId, sessionPath],
  );
}

async function upsertConversationMessages(client, userId, sender, record) {
  const msgs = Array.isArray(record?.msgs) ? record.msgs : [];
  if (msgs.length === 0) return { conversations: 0, messages: 0 };

  const conversationResult = await client.query(
    `INSERT INTO conversations (user_id, sender, last_message_at, metadata)
     VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4::jsonb)
     ON CONFLICT (user_id, sender) DO UPDATE SET
       last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
       metadata = conversations.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      userId,
      sender,
      record.lastAt ? new Date(record.lastAt).toISOString() : null,
      JSON.stringify({ migratedFromJson: true }),
    ],
  );
  const conversationId = conversationResult.rows[0].id;

  let inserted = 0;
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i] || {};
    const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
    const direction = role === 'assistant' ? 'outbound' : 'inbound';
    const content = String(msg.content || '').trim();
    if (!content) continue;

    const providerMessageId = msg.id || `json:${userId}:${sender}:${i}:${Buffer.from(content).toString('base64url').slice(0, 32)}`;
    await client.query(
      `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'migrated', $8::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        conversationId,
        userId,
        sender,
        direction,
        role,
        content,
        providerMessageId,
        JSON.stringify(msg),
      ],
    );
    inserted++;
  }

  return { conversations: 1, messages: inserted };
}

async function migrateUserDirectory(client, userId, userDir) {
  const config = await readJson(path.join(userDir, 'config.json'), null);
  const conversations = await readJson(path.join(userDir, 'conversations.json'), {});

  await upsertConfig(client, userId, config || {});
  await upsertSession(client, userId, userDir);

  let convCount = 0;
  let msgCount = 0;
  for (const [sender, record] of Object.entries(conversations || {})) {
    const result = await upsertConversationMessages(client, userId, sender, record);
    convCount += result.conversations;
    msgCount += result.messages;
  }

  return { convCount, msgCount };
}

async function run() {
  if (!db.isConfigured()) {
    throw new Error('DATABASE_URL is required before migrating JSON data');
  }

  await migrate();

  const root = dataRoot();
  const usersFile = path.join(root, 'users.json');
  const usersData = await readJson(usersFile, { users: [] });
  const dirs = await userDirectories(root);
  const dirsByUserId = new Map(dirs.map(dir => [path.basename(dir), dir]));

  const stats = { users: 0, configs: 0, conversations: 0, messages: 0, skippedUsers: 0 };

  await db.transaction(async (client) => {
    for (const user of usersData.users || []) {
      const userId = await upsertUser(client, user);
      if (!userId) {
        stats.skippedUsers++;
        continue;
      }
      stats.users++;

      const userDir = dirsByUserId.get(userId);
      if (!userDir) continue;

      const result = await migrateUserDirectory(client, userId, userDir);
      stats.configs++;
      stats.conversations += result.convCount;
      stats.messages += result.msgCount;
    }
  });

  console.log(JSON.stringify({ ok: true, root, ...stats }, null, 2));
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { run };
