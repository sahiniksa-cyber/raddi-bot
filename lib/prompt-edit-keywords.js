'use strict';

// Pure helpers: detect a prompt-edit command (typo-tolerant) and yes/no
// confirmations in Arabic. No I/O, no dependencies — trivially unit-testable.

function normalizeArabic(s) {
  return String(s || '')
    .replace(/[ً-ْ]/g, '') // strip tashkeel/diacritics
    .replace(/ـ/g, '')          // strip tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/ء/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[n];
}

const EDIT_KEYWORDS = ['تعديل', 'عدل', 'برومنت', 'البرومنت', 'ضيف', 'اضف'].map(normalizeArabic);
const YES_WORDS = ['نعم', 'اي', 'ايه', 'ايوه', 'تمام', 'تم', 'اكد', 'اكدت', 'تاكيد', 'التاكيد',
  'اكيد', 'موافق', 'اوكي', 'ابشر', 'طبق', 'نفذ', 'ماشي', 'زين', 'ok', 'yes'].map(normalizeArabic);
// NOTE: no short abbreviation like "الغ" — it fuzzy-matched "الو" (hello) and
// canceled edits (production 2026-07-02). Cancel words are full/explicit.
const NO_WORDS = ['لا', 'لأ', 'الغاء', 'الغي', 'تراجع', 'كنسل', 'ارفض', 'no', 'cancel'].map(normalizeArabic);

// matches a normalized token against a word list: exact, or edit-distance <= 1
// when both tokens are at least 3 chars long (avoids over-matching tiny words).
function matchesWord(token, words) {
  for (const w of words) {
    if (token === w) return true;
    if (token.length >= 3 && w.length >= 3 && levenshtein(token, w) <= 1) return true;
  }
  return false;
}

// Confirmation detection for the two-step flow. Scans tokens so natural replies
// like "تم اكد" / "ابغى اكد" are recognized — but only ANY-token for SHORT
// replies (<= 3 words); a longer sentence must START with the word, so a long
// instruction that merely contains "لا"/"اي" mid-way is never read as yes/no.
function confirmMatch(text, words) {
  const norm = normalizeArabic(text);
  if (!norm) return false;
  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const scan = tokens.length <= 3 ? tokens : [tokens[0]];
  return scan.some((t) => matchesWord(t, words));
}

function splitFirstToken(text) {
  const trimmed = String(text || '').trim();
  const m = trimmed.match(/^(\S+)([\s\S]*)$/);
  if (!m) return { first: '', rest: '' };
  const first = m[1].replace(/[:：،.\-_]+$/, '');
  const rest = m[2].replace(/^[\s:：،.\-_]+/, '').trim();
  return { first, rest };
}

function detectEditCommand(text) {
  const { first, rest } = splitFirstToken(text);
  const token = normalizeArabic(first);
  if (token && matchesWord(token, EDIT_KEYWORDS)) {
    return { matched: true, body: rest };
  }
  return { matched: false, body: '' };
}

function isYes(text) {
  return confirmMatch(text, YES_WORDS);
}

function isNo(text) {
  return confirmMatch(text, NO_WORDS);
}

module.exports = { normalizeArabic, detectEditCommand, isYes, isNo, EDIT_KEYWORDS };
