'use strict';

/**
 * src/workers/profile-extractor.js — Customer profile extractor.
 *
 * Lightweight per-conversation memory. Pulled lazily by ai-worker before
 * each reply; populated fire-and-forget via setImmediate after the reply
 * has been queued for send. Never throws to its caller — any DB or parse
 * failure is logged and swallowed so the bot keeps replying.
 *
 * Regex-first extraction (free + fast). AI-based extraction is OPTIONAL
 * and can be layered later; we keep this module dependency-free of the
 * AI client to avoid coupling cost / rate limits to memory.
 */

const db = require('../db/client');

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Matches "order ZX9988", "order #ZX9988", "طلب AB12-99", "طلب رقم AB12-99",
// "اوردر no. 1234" etc. The intermediate word (رقم / no. / num) is optional.
const ORDER_RE = /(?:طلب|اوردر|order)\s*(?:رقم|no\.?|num)?\s*[#:]?\s*([A-Z0-9-]{4,20})\b/i;
// "اسمي X" / "انا X" / "أنا X" — capture 2–30 chars of letters and spaces.
const NAME_RE = /(?:اسمي|انا|أنا)\s+([\p{L}\s]{2,30})/u;

const ALLOWED_KEYS = ['name', 'email', 'phone', 'last_order_ref', 'open_question', 'notes'];

/**
 * Extract structured fields from a free-text customer message using
 * regex only. Returns a (possibly empty) plain object.
 *
 * @param {string} text
 * @returns {{name?: string, email?: string, last_order_ref?: string}}
 */
function extractFromText(text) {
  const t = String(text || '');
  if (!t.trim()) return {};

  const out = {};

  const emails = t.match(EMAIL_RE);
  if (emails && emails[0]) {
    out.email = emails[0].toLowerCase();
  }

  const orderM = t.match(ORDER_RE);
  if (orderM && orderM[1]) {
    out.last_order_ref = orderM[1];
  }

  const nameM = t.match(NAME_RE);
  if (nameM && nameM[1]) {
    const cleaned = nameM[1].trim().split(/\s+/).slice(0, 3).join(' ');
    if (cleaned.length >= 2) {
      out.name = cleaned;
    }
  }

  return out;
}

/**
 * Read a customer profile for a conversation. Returns null when none
 * exists or when the table is missing (so the worker keeps running on
 * pre-migration databases).
 */
async function getProfile({ conversationId, database = db } = {}) {
  if (!conversationId) return null;
  if (!database?.isConfigured?.()) return null;
  try {
    const r = await database.query(
      `SELECT name, email, phone, last_order_ref, preferences, open_question, notes
         FROM customer_profiles WHERE conversation_id = $1`,
      [conversationId],
    );
    return r.rows[0] || null;
  } catch (_err) {
    // Fail-open: table may not exist yet, or transient DB hiccup.
    return null;
  }
}

/**
 * Upsert allowed fields for a (conversationId, userId). Silently no-ops
 * when nothing to write or when the table is missing.
 */
async function upsertProfile({ conversationId, userId, fields, database = db } = {}) {
  if (!conversationId || !userId) return;
  if (!fields || typeof fields !== 'object') return;
  if (!database?.isConfigured?.()) return;

  const present = ALLOWED_KEYS.filter(
    k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '',
  );
  if (present.length === 0) return;

  const insertCols = ['conversation_id', 'user_id', ...present].join(', ');
  const insertPlaceholders = ['$1', '$2', ...present.map((_, i) => `$${i + 3}`)].join(', ');
  const updates = present.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const values = [conversationId, userId, ...present.map(k => fields[k])];

  try {
    await database.query(
      `INSERT INTO customer_profiles (${insertCols})
       VALUES (${insertPlaceholders})
       ON CONFLICT (conversation_id) DO UPDATE
         SET ${updates}, updated_at = NOW()`,
      values,
    );
  } catch (err) {
    console.warn(
      `${new Date().toISOString()} [profile-extractor] upsert failed: ${err.message}`,
    );
  }
}

/**
 * Fire-and-forget extraction. Returns synchronously; the actual DB work
 * happens on the next macrotask. Never throws.
 */
function extractAsync({ conversationId, userId, customerText, database = db } = {}) {
  setImmediate(async () => {
    try {
      const fields = extractFromText(customerText);
      if (Object.keys(fields).length > 0) {
        await upsertProfile({ conversationId, userId, fields, database });
      }
    } catch (err) {
      console.warn(
        `${new Date().toISOString()} [profile-extractor] async failed: ${err && err.message ? err.message : err}`,
      );
    }
  });
}

module.exports = {
  extractFromText,
  getProfile,
  upsertProfile,
  extractAsync,
  ALLOWED_KEYS,
};
