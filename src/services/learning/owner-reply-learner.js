'use strict';

// Phase-1 self-learning: the bot learns ONLY from the owner's own manual
// replies (messages.status='sent_by_human'). The owner's words are the sole
// source of truth — no AI generation, no learning from customer text, so the
// knowledge base cannot be poisoned or hallucinated. Approved design 2026-06-10.

const db = require('../../db/client');

// Local Arabic normalizer for the dedup key (self-contained on purpose — no
// cross-module dependency). Folds hamza/alef variants, ta-marbuta, alef
// maqsura, strips punctuation, collapses whitespace.
function normalizeArabic(value) {
  return String(value || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MAX_PER_RUN = parseInt(process.env.LEARNING_MAX_PER_RUN || '20', 10);
const MAX_TOTAL = parseInt(process.env.LEARNING_MAX_TOTAL || '300', 10);
const LOOKBACK_MS = parseInt(process.env.LEARNING_LOOKBACK_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const PAIR_WINDOW_HOURS = 6;
const MIN_QUESTION_LEN = 8;
const MIN_ANSWER_LEN = 8;
const MAX_TEXT_LEN = 500;

function learningEnabled() {
  return process.env.LEARNED_REPLIES_ENABLED !== 'false';
}

const GREETING_ONLY_RE = /^(و?عليكم السلام|السلام عليكم|هلا|اهلا|أهلا|حياك|مرحبا)[\sو،.!ورحمة الله بركاته]*$/;
const MEDIA_PLACEHOLDER_RE = /^\[(صورة|ملف|صوت|فيديو|ملصق)/;

function isLearnablePair(question, answer) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (q.length < MIN_QUESTION_LEN || a.length < MIN_ANSWER_LEN) return false;
  if (MEDIA_PLACEHOLDER_RE.test(q) || MEDIA_PLACEHOLDER_RE.test(a)) return false;
  if (GREETING_ONLY_RE.test(a)) return false;
  if (a.includes('[تحويل:')) return false;
  return true;
}

function normalizeQuestion(question) {
  return normalizeArabic(question).slice(0, MAX_TEXT_LEN);
}

// Pairs each recent owner manual reply with the LATEST inbound customer
// message before it (same conversation, within a few hours) that the bot did
// NOT answer — i.e. the exact cases where the owner had to step in.
async function extractLearnablePairs({ database = db, userId, lookbackMs = LOOKBACK_MS } = {}) {
  if (!userId || !database?.isConfigured?.()) return [];
  const result = await database.query(
    `SELECT om.id AS owner_message_id,
            om.conversation_id,
            om.content AS answer,
            im.id AS question_message_id,
            im.content AS question
       FROM messages om
       JOIN LATERAL (
         SELECT id, content
           FROM messages im
          WHERE im.conversation_id = om.conversation_id
            AND im.user_id = om.user_id
            AND im.direction = 'inbound'
            AND im.created_at < om.created_at
            AND im.created_at > om.created_at - interval '${PAIR_WINDOW_HOURS} hours'
            AND im.status <> 'answered_by_ai'
          ORDER BY im.created_at DESC
          LIMIT 1
       ) im ON TRUE
      WHERE om.user_id = $1
        AND om.direction = 'outbound'
        AND om.status = 'sent_by_human'
        AND om.created_at > NOW() - ($2 * interval '1 millisecond')
      ORDER BY om.created_at ASC
      LIMIT 100`,
    [userId, lookbackMs],
  );
  return (result.rows || []).map((row) => ({
    question: String(row.question || '').trim().slice(0, MAX_TEXT_LEN),
    answer: String(row.answer || '').trim().slice(0, MAX_TEXT_LEN),
    conversationId: row.conversation_id,
    messageId: row.owner_message_id,
  }));
}

async function saveLearnedReplies({ database = db, userId, pairs = [] } = {}) {
  if (!userId || !database?.isConfigured?.() || !pairs.length) return { saved: 0 };

  const countResult = await database.query(
    `SELECT COUNT(*) AS n FROM learned_replies WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  const active = Number(countResult.rows[0]?.n || 0);
  if (active >= MAX_TOTAL) return { saved: 0, reason: 'cap_reached' };

  const budget = Math.min(MAX_PER_RUN, MAX_TOTAL - active);
  let saved = 0;
  for (const pair of pairs.slice(0, budget)) {
    const normalized = normalizeQuestion(pair.question);
    if (!normalized) continue;
    await database.query(
      `INSERT INTO learned_replies
         (user_id, question, answer, normalized_question, source_conversation_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, normalized_question) DO NOTHING`,
      [userId, pair.question, pair.answer, normalized, pair.conversationId || null, pair.messageId || null],
    );
    saved++;
  }
  return { saved };
}

// Shapes active learned rows as knowledge-retrieval entries. The reply line
// carries BOTH the original question and the owner's answer so the AI sees
// the full context, clearly attributed to the store owner.
async function loadActiveLearnedReplies({ database = db, userId } = {}) {
  if (!learningEnabled() || !userId || !database?.isConfigured?.()) return [];
  try {
    const result = await database.query(
      `SELECT question, answer FROM learned_replies
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, MAX_TOTAL],
    );
    return (result.rows || []).map((row) => ({
      keyword: String(row.question || ''),
      reply: `إذا سُئلت "${row.question}" فجواب صاحب المتجر: ${row.answer}`,
    }));
  } catch (_) {
    return []; // fail-open: learning must never break replies
  }
}

async function listLearnedReplies({ database = db, userId } = {}) {
  if (!userId || !database?.isConfigured?.()) return [];
  const result = await database.query(
    `SELECT id, question, answer, status, created_at
       FROM learned_replies
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [userId],
  );
  return result.rows || [];
}

async function setLearnedReplyStatus({ database = db, userId, id, status } = {}) {
  if (!userId || !id || !['active', 'disabled'].includes(status) || !database?.isConfigured?.()) return 0;
  const result = await database.query(
    `UPDATE learned_replies SET status = $3 WHERE user_id = $1 AND id = $2`,
    [userId, id, status],
  );
  return result.rowCount || 0;
}

async function runLearningPass({ database = db, lookbackMs = LOOKBACK_MS } = {}) {
  if (!learningEnabled() || !database?.isConfigured?.()) return { users: 0, learned: 0 };

  const usersResult = await database.query(
    `SELECT DISTINCT user_id FROM messages
      WHERE direction = 'outbound' AND status = 'sent_by_human'
        AND created_at > NOW() - ($1 * interval '1 millisecond')`,
    [lookbackMs],
  );
  let learned = 0;
  let users = 0;
  for (const row of usersResult.rows || []) {
    users++;
    try {
      const pairs = (await extractLearnablePairs({ database, userId: row.user_id, lookbackMs }))
        .filter((p) => isLearnablePair(p.question, p.answer));
      if (!pairs.length) continue;
      const result = await saveLearnedReplies({ database, userId: row.user_id, pairs });
      learned += result.saved || 0;
    } catch (err) {
      console.warn(`${new Date().toISOString()} [learning] pass failed for user ${row.user_id}: ${err.message}`);
    }
  }
  return { users, learned };
}

module.exports = {
  isLearnablePair,
  normalizeQuestion,
  extractLearnablePairs,
  saveLearnedReplies,
  loadActiveLearnedReplies,
  listLearnedReplies,
  setLearnedReplyStatus,
  runLearningPass,
};
