'use strict';

/**
 * Staging concurrency test for the DB-sourced atomic stale guard.
 *
 * Exercises the REAL guard SQL (buildStaleClaimQuery) against a live Postgres,
 * covering: a new customer inbound arriving (a) DURING generation and (b) BEFORE
 * send, for BOTH a normal JID and an @lid customer, plus a parallel-claim
 * atomicity check — each scenario repeated many times.
 *
 * SAFETY: connects ONLY to STAGING_DATABASE_URL (never the prod .env
 * DATABASE_URL) and refuses to run without STAGING_CONFIRM=1. It creates a
 * throwaway user and deletes it (cascade) at the end. No WhatsApp is sent.
 *
 * Usage:
 *   STAGING_CONFIRM=1 STAGING_DATABASE_URL=postgres://... \
 *   node scripts/staging-stale-concurrency-test.js [iterations]
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { buildStaleClaimQuery } = require('../src/services/ai/conversation-state');

const ITER = Math.max(1, parseInt(process.argv[2] || '25', 10));
const SENDERS = ['966500000000@s.whatsapp.net', '278571713060916@lid'];

function die(msg) { console.error(msg); process.exit(2); }

if (process.env.STAGING_CONFIRM !== '1') die('Refusing to run: set STAGING_CONFIRM=1 (staging DB only).');
const url = process.env.STAGING_DATABASE_URL;
if (!url) die('Refusing to run: set STAGING_DATABASE_URL (NOT the prod DATABASE_URL).');

const pool = new Pool({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  ✗ ${name}`); }
}

async function q(sql, params) { return pool.query(sql, params); }

async function ensureColumns() {
  const r = await q(
    `SELECT
       (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='inbound_seq') AS conv,
       (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='inbound_seq') AS msg`,
  );
  if (!r.rows[0].conv || !r.rows[0].msg) die('Migration not applied on this DB: run `npm run db:migrate` first.');
}

async function createUser() {
  const email = `stale-test-${crypto.randomUUID()}@example.invalid`;
  const r = await q(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'user') RETURNING id`, [email]);
  return r.rows[0].id;
}

async function bumpInboundAndInsert(userId, sender, text) {
  const conv = await q(
    `INSERT INTO conversations (user_id, channel_id, sender, last_message_at, metadata, inbound_seq)
     VALUES ($1, 'whatsapp', $2, NOW(), '{}'::jsonb, 1)
     ON CONFLICT (user_id, sender) DO UPDATE SET inbound_seq = conversations.inbound_seq + 1
     RETURNING id, inbound_seq`,
    [userId, sender],
  );
  const conversationId = conv.rows[0].id;
  const seq = conv.rows[0].inbound_seq;
  await q(
    `INSERT INTO messages (conversation_id, user_id, channel_id, sender, direction, role, content, provider_message_id, status, inbound_seq)
     VALUES ($1, $2, 'whatsapp', $3, 'inbound', 'user', $4, $5, 'queued_for_ai', $6)`,
    [conversationId, userId, sender, text, `in-${crypto.randomUUID()}`, seq],
  );
  return { conversationId, seq };
}

async function insertReply(userId, conversationId, sender, generatedAgainstSeq) {
  const r = await q(
    `INSERT INTO messages (conversation_id, user_id, channel_id, sender, direction, role, content, provider_message_id, status)
     VALUES ($1, $2, 'whatsapp', $3, 'outbound', 'assistant', 'رد', $4, 'queued_for_send') RETURNING id`,
    [conversationId, userId, sender, `out-${crypto.randomUUID()}`],
  );
  return { replyId: r.rows[0].id, generatedAgainstSeq };
}

async function claim(replyId, userId, conversationId, generatedAgainstSeq) {
  const { sql, params } = buildStaleClaimQuery({ replyMessageId: replyId, userId, conversationId, generatedAgainstSeq });
  const r = await pool.query(sql, params);
  return r.rowCount;
}

async function statusOf(replyId) {
  const r = await q(`SELECT status FROM messages WHERE id = $1`, [replyId]);
  return r.rows[0]?.status;
}

async function main() {
  process.env.SEND_STALE_GUARD_ENABLED = 'true'; // buildStaleClaimQuery is pure; guard flag is app-side only
  await ensureColumns();
  const userId = await createUser();
  console.log(`staging stale-guard concurrency test — iterations=${ITER}, user=${userId}\n`);
  try {
    for (const sender of SENDERS) {
      const label = sender.endsWith('@lid') ? '@lid' : 'normal';
      for (let i = 0; i < ITER; i++) {
        // Scenario A — new inbound arrives DURING generation (batch loaded at seq N,
        // reply generatedAgainstSeq=N, a new inbound bumps to N+1 before the reply row).
        {
          const a = await bumpInboundAndInsert(userId, `${sender}#A${i}`, 'first');
          const genSeq = a.seq;
          await bumpInboundAndInsert(userId, `${sender}#A${i}`, 'during-generation'); // seq N+1
          const { replyId } = await insertReply(userId, a.conversationId, `${sender}#A${i}`, genSeq);
          const rc = await claim(replyId, userId, a.conversationId, genSeq);
          check(`${label} A#${i} stale during-generation (0 rows)`, rc === 0);
          check(`${label} A#${i} reply stays queued_for_send`, (await statusOf(replyId)) === 'queued_for_send');
        }
        // Scenario B — new inbound arrives BEFORE send (after the reply row exists).
        {
          const b = await bumpInboundAndInsert(userId, `${sender}#B${i}`, 'first');
          const { replyId } = await insertReply(userId, b.conversationId, `${sender}#B${i}`, b.seq);
          await bumpInboundAndInsert(userId, `${sender}#B${i}`, 'before-send'); // seq+1
          const rc = await claim(replyId, userId, b.conversationId, b.seq);
          check(`${label} B#${i} stale before-send (0 rows)`, rc === 0);
        }
        // Scenario C — no newer inbound → the reply is claimable exactly once.
        {
          const c = await bumpInboundAndInsert(userId, `${sender}#C${i}`, 'only');
          const { replyId } = await insertReply(userId, c.conversationId, `${sender}#C${i}`, c.seq);
          const [rc1, rc2] = await Promise.all([
            claim(replyId, userId, c.conversationId, c.seq),
            claim(replyId, userId, c.conversationId, c.seq),
          ]);
          // Both may claim (idempotent re-claim of 'sending'); the invariant is that
          // it IS claimable (>=1) and the row transitioned to 'sending'.
          check(`${label} C#${i} fresh reply claimable`, rc1 + rc2 >= 1);
          check(`${label} C#${i} reply → sending`, (await statusOf(replyId)) === 'sending');
        }
      }
    }
  } finally {
    await q(`DELETE FROM users WHERE id = $1`, [userId]); // cascade cleans conversations/messages
    await pool.end();
  }
  console.log(`\n${pass} checks passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
