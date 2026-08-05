'use strict';

// Pure helpers for the guided WhatsApp edit menu. No I/O, no async — every
// function is deterministic and unit-testable. The service layer wires these to
// the DB session row and the config appliers.

const { normalizeArabic, levenshtein } = require('./prompt-edit-keywords');

// Words that DELIBERATELY open the edit menu. Deliberately NARROW — action verbs
// like احذف/غيّر/ضيف are NOT here, so normal team chatter that merely starts with
// such a word never pops the menu. Typo-tolerant (edit-distance ≤ 1) for the
// longer words; short words must match exactly.
const MENU_TRIGGERS = ['تعديل', 'تعديلات', 'عدل', 'فلاش', 'قائمة', 'اعدادات', 'ضبط'].map(normalizeArabic);

function isMenuTrigger(firstToken) {
  const t = normalizeArabic(String(firstToken || '').replace(/[:：،.\-_]+$/, ''));
  if (!t) return false;
  if (MENU_TRIGGERS.includes(t)) return true;
  return t.length >= 4 && MENU_TRIGGERS.some((w) => w.length >= 4 && levenshtein(t, w) <= 1);
}

// ── Section registry ───────────────────────────────────────────────────────
// `kind` decides how the service handles the section after it's chosen:
//   text     → free text → AI merge (botInstructions)
//   products → free text → AI plan (products)
//   instant  → keyword then reply (autoReplyKeywords)
//   number   → phone add / احذف (doNotReplyList)
//   style    → sub-menus (replyStyle enums)
//   phrases  → phrase add / احذف on a replyStyle string array
//   forbidden→ sub-choice (word/phrase) then phrase add / احذف
const SECTIONS = [
  { n: 1, key: 'prompt', label: 'تعليمات البوت', kind: 'text' },
  { n: 2, key: 'products', label: 'المنتجات والأسعار', kind: 'products' },
  { n: 3, key: 'instant_replies', label: 'الردود الفورية', kind: 'instant' },
  { n: 4, key: 'do_not_reply', label: 'إيقاف البوت لأرقام محددة', kind: 'number' },
  { n: 5, key: 'reply_style', label: 'طريقة رد البوت', kind: 'style' },
  { n: 6, key: 'closing', label: 'عبارات الإغلاق', kind: 'phrases', styleField: 'closingPhrases' },
  { n: 7, key: 'greeting', label: 'عبارات التحية', kind: 'phrases', styleField: 'greetingPhrases' },
  { n: 8, key: 'forbidden', label: 'الكلمات والعبارات الممنوعة', kind: 'forbidden' },
];

// Reply-style attributes and their fixed value sets (mirror the dashboard
// selects exactly so WhatsApp edits and the dashboard stay in sync).
const STYLE_ATTRS = [
  {
    n: 1, key: 'tone', label: 'النبرة العامة', field: 'tone',
    values: ['ودي ومحترم', 'رسمي ومحترف', 'مرح ولطيف', 'هادئ وصبور', 'حماسي ونشط']
      .map((v) => ({ v, label: v })),
  },
  {
    n: 2, key: 'language', label: 'اللغة', field: 'languageStyle',
    values: [
      { v: 'dialect', label: 'عامية (أكثر طبيعية)' },
      { v: 'standard', label: 'فصحى سهلة' },
      { v: 'formal', label: 'فصحى رسمية' },
    ],
  },
  {
    n: 3, key: 'dialect', label: 'اللهجة', field: 'dialect',
    values: ['السعودية الخفيفة', 'السعودية الحجازية', 'السعودية النجدية', 'الإماراتية',
      'الكويتية', 'المصرية', 'الشامية', 'المغربية'].map((v) => ({ v, label: v })),
  },
  {
    n: 4, key: 'emoji', label: 'مستوى الإيموجي', field: 'emojiLevel',
    values: [
      { v: 'none', label: 'بدون إيموجي' },
      { v: 'light', label: 'قليل' },
      { v: 'medium', label: 'معتدل' },
      { v: 'heavy', label: 'كثير' },
    ],
  },
  {
    n: 5, key: 'length', label: 'طول الرد', field: 'replyLength',
    values: [
      { v: 'short', label: 'قصير جداً' },
      { v: 'medium', label: 'متوسط' },
      { v: 'long', label: 'مفصّل' },
    ],
  },
];

// Remove-intent keywords for list sections (typo-tolerant via normalize only —
// these are matched as the FIRST token of a list-edit message).
const REMOVE_WORDS = ['احذف', 'امسح', 'شيل', 'ازل', 'الغ', 'الغاء', 'remove', 'delete']
  .map(normalizeArabic);

// ── Numeric selection parsing ───────────────────────────────────────────────
// Accepts Western (1) and Arabic-Indic (١) digits, optionally prefixed by a
// word like "رقم". Returns the integer, or null when the text isn't a bare
// selection.
const ARABIC_INDIC = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

function toWesternDigits(s) {
  return String(s || '').replace(/[٠-٩]/g, (d) => ARABIC_INDIC[d] || d);
}

function parseSelection(text) {
  const cleaned = toWesternDigits(String(text || '').trim())
    .replace(/^[^\d]*?(?=\d)/, ''); // drop a leading "رقم "/emoji/etc. before the first digit
  const m = cleaned.match(/^(\d{1,2})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ── Menu text builders ──────────────────────────────────────────────────────
const DIGIT_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

function numbered(items, labelOf) {
  return items.map((it, i) => `${DIGIT_EMOJI[i] || `${i + 1}.`} ${labelOf(it)}`).join('\n');
}

function buildMainMenu() {
  return ['وش تبي تعدّل؟ رد بالرقم:', numbered(SECTIONS, (s) => s.label),
    '', '(للإلغاء اكتب: لا)'].join('\n');
}

function buildStyleAttrMenu() {
  return ['وش تبي تعدّل في طريقة الرد؟ رد بالرقم:',
    numbered(STYLE_ATTRS, (a) => a.label), '', '(للإلغاء اكتب: لا)'].join('\n');
}

function buildStyleValueMenu(attrKey) {
  const attr = styleAttrByKey(attrKey);
  if (!attr) return null;
  return [`اختر ${attr.label} بالرقم:`,
    numbered(attr.values, (v) => v.label), '', '(للإلغاء اكتب: لا)'].join('\n');
}

const FORBIDDEN_KINDS = [
  { n: 1, key: 'word', label: 'كلمة ممنوعة (كلمة واحدة)', styleField: 'avoidWords' },
  { n: 2, key: 'phrase', label: 'عبارة ممنوعة (جملة كاملة)', styleField: 'avoidPhrases' },
];

function buildForbiddenKindMenu() {
  return ['وش تبي تعدّل؟ رد بالرقم:',
    numbered(FORBIDDEN_KINDS, (k) => k.label), '', '(للإلغاء اكتب: لا)'].join('\n');
}

// ── Lookups ─────────────────────────────────────────────────────────────────
function sectionByNumber(n) { return SECTIONS.find((s) => s.n === n) || null; }
function sectionByKey(k) { return SECTIONS.find((s) => s.key === k) || null; }
function styleAttrByNumber(n) { return STYLE_ATTRS.find((a) => a.n === n) || null; }
function styleAttrByKey(k) { return STYLE_ATTRS.find((a) => a.key === k) || null; }
function styleValueByNumber(attrKey, n) {
  const attr = styleAttrByKey(attrKey);
  if (!attr) return null;
  return attr.values[n - 1] || null;
}
function forbiddenKindByNumber(n) { return FORBIDDEN_KINDS.find((k) => k.n === n) || null; }
function forbiddenKindByKey(k) { return FORBIDDEN_KINDS.find((x) => x.key === k) || null; }

// ── List-input parsing (add vs remove) ──────────────────────────────────────
function parseListInput(text) {
  const raw = String(text || '').trim();
  const firstTokenMatch = raw.match(/^(\S+)([\s\S]*)$/);
  if (firstTokenMatch) {
    const firstNorm = normalizeArabic(firstTokenMatch[1].replace(/[:：،.\-_]+$/, ''));
    if (REMOVE_WORDS.includes(firstNorm)) {
      const value = firstTokenMatch[2].replace(/^[\s:：،.\-_]+/, '').trim();
      return { action: 'remove', value };
    }
  }
  return { action: 'add', value: raw };
}

// ── Phrase-array delta applier (string arrays: closing/greeting/avoid*) ──────
// Deterministic. Returns exactly one of:
//   { value, summary } | { noop: true, summary } | { error }
function applyPhraseDelta(current, op) {
  const arr = Array.isArray(current) ? current.map((x) => String(x)) : [];
  const value = String((op && op.value) || '').trim();
  if (!value) return { error: 'اكتب العبارة/الكلمة.' };
  const targetNorm = normalizeArabic(value);

  if (op.action === 'remove') {
    const kept = arr.filter((x) => normalizeArabic(x) !== targetNorm);
    if (kept.length === arr.length) return { noop: true, summary: `"${value}" مو موجودة في القائمة.` };
    return { value: kept, summary: `حذف: ${value}` };
  }
  if (arr.some((x) => normalizeArabic(x) === targetNorm)) {
    return { noop: true, summary: `"${value}" موجودة مسبقاً.` };
  }
  return { value: [...arr, value], summary: `إضافة: ${value}` };
}

module.exports = {
  SECTIONS, STYLE_ATTRS, FORBIDDEN_KINDS, REMOVE_WORDS, MENU_TRIGGERS, isMenuTrigger,
  buildMainMenu, buildStyleAttrMenu, buildStyleValueMenu, buildForbiddenKindMenu,
  sectionByNumber, sectionByKey, styleAttrByNumber, styleAttrByKey, styleValueByNumber,
  forbiddenKindByNumber, forbiddenKindByKey,
  parseSelection, parseListInput, applyPhraseDelta, toWesternDigits,
};
