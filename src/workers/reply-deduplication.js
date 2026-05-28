'use strict';

/**
 * src/workers/reply-deduplication.js
 *
 * Lightweight similarity detection to prevent the AI from sending the same
 * reply (or near-duplicate) to a customer twice in a row. Uses Jaccard
 * similarity over bigrams after Arabic normalization.
 *
 * Used by `ai-worker.js` before persisting an assistant reply; if a
 * near-duplicate is detected, the worker can ask the model to regenerate.
 */

const db = require('../db/client');

const ARABIC_NORMALIZATION = [
  [/[ؐ-ؚ]/g, ''], // Arabic small marks
  [/[ً-ْ]/g, ''], // tashkeel (fatha/kasra/damma/shadda/sukun)
  [/[ٓ-ٟ]/g, ''], // additional marks
  [/[ٰ]/g, ''],        // dagger alif
  [/[ۖ-ۭ]/g, ''], // quranic marks
  [/ـ/g, ''],               // tatweel
  [/[إأآا]/g, 'ا'],
  [/[ة]/g, 'ه'],
  [/[ى]/g, 'ي'],
  [/[ؤ]/g, 'و'],
  [/[ئ]/g, 'ي'],
];

/**
 * Normalize an Arabic/Latin string so similarity is robust to diacritics,
 * alif variants, ta marbuta, alif maqsura, hamzas, tatweel, casing, and
 * any non-letter/number punctuation.
 */
function normalize(input) {
  let s = String(input || '');
  for (const [re, rep] of ARABIC_NORMALIZATION) s = s.replace(re, rep);
  s = s
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s;
}

/** Build the set of character bigrams from a normalized string. */
function bigrams(str) {
  const s = String(str || '');
  if (s.length < 2) return new Set([s]);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Jaccard similarity over character bigrams of two normalized strings.
 * Returns a number in [0, 1].
 */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const sa = bigrams(na);
  const sb = bigrams(nb);
  if (sa.size === 0 || sb.size === 0) return 0;

  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pull the last N assistant replies from the DB and return the first one
 * whose Jaccard similarity to `candidate` >= threshold, otherwise null.
 *
 * @param {object} params
 * @param {object} params.db        — pg-like client with `.query()` (defaults to project db)
 * @param {string} params.conversationId
 * @param {string} params.candidate — the candidate reply text
 * @param {number} [params.lookback=3]
 * @param {number} [params.threshold=0.85]
 */
async function findDuplicateRecentReply({
  db: database = db,
  conversationId,
  candidate,
  lookback = 3,
  threshold = 0.85,
} = {}) {
  if (!database || !conversationId || !candidate) return null;
  if (typeof database.query !== 'function') return null;

  let rows;
  try {
    const result = await database.query(
      `SELECT content
       FROM messages
       WHERE conversation_id = $1
         AND direction = 'outbound'
         AND role = 'assistant'
       ORDER BY created_at DESC
       LIMIT $2`,
      [conversationId, Math.max(1, Number(lookback) || 1)],
    );
    rows = result.rows || [];
  } catch (_err) {
    return null;
  }

  for (const row of rows) {
    const prev = row?.content || '';
    if (!prev) continue;
    const score = similarity(candidate, prev);
    if (score >= threshold) {
      return { content: prev, similarity: score };
    }
  }
  return null;
}

module.exports = {
  bigrams,
  findDuplicateRecentReply,
  normalize,
  similarity,
};
