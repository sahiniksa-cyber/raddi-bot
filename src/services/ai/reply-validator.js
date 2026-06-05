'use strict';

const { tokenize } = require('./knowledge-retrieval');

// قصّ الرد على حدّ الطول، مفضّلاً نهاية جملة كاملة قبل الحدّ.
function enforceLength(reply, maxLen) {
  const text = String(reply || '').trim();
  const limit = Math.max(40, parseInt(maxLen, 10) || 300);
  if (text.length <= limit) return text;

  const slice = text.slice(0, limit + 1);
  // ابحث عن آخر فاصل جملة ضمن الحد
  const lastBoundary = Math.max(
    slice.lastIndexOf('.'), slice.lastIndexOf('!'),
    slice.lastIndexOf('؟'), slice.lastIndexOf('\n'),
  );
  if (lastBoundary >= 20) return text.slice(0, lastBoundary + 1).trim();
  return text.slice(0, limit).trim();
}

// توكنات كلمات الطلب (بعد التطبيع بـnormalizeArabic)
const WANT_TOKENS = new Set([
  'يبي', 'يبغي',           // يبي / يبغى (مطبّع)
  'ابي',                    // أبي / ابي
  'ودي',                    // ودي
  'ابغي',                   // أبغى / ابغى (مطبّع)
  'احتاج',                  // أحتاج / احتاج
  'اكلم',                   // اكلم / ممكن أكلم
  'اتواصل',                 // أتواصل / اتواصل
  'ممكن',                   // ممكن (بالاقتران مع توكن بشري)
]);

// توكنات كلمات البشر (بعد التطبيع) — بما فيها صيغ "ال" لأن tokenize لا تحذفها
const HUMAN_TOKENS = new Set([
  'موظف', 'مختص',
  'مسؤول', 'مسئول',         // بدون "ال"
  'المسؤول', 'المسئول',     // مع "ال"
  'انسان',                  // إنسان / انسان (مطبّع)
  'بشر',
  'المدير', 'المالك',
  'صاحب', 'المحل',          // صاحب المحل (توكنان)
  'احد',                    // "أحد" — بدون "ال" ودون أن يكون جزء من كلمة أخرى
]);

function detectEscalationIntent(customerText) {
  const tokens = tokenize(String(customerText || ''));
  const hasWant = tokens.some(t => WANT_TOKENS.has(t));
  const hasHuman = tokens.some(t => HUMAN_TOKENS.has(t));
  return hasWant && hasHuman;
}

function enforceEscalationTag(reply, config = {}, customerText = '') {
  const text = String(reply || '');
  if (/\[تحويل:/.test(text)) return text;            // النموذج وضعها
  if (!detectEscalationIntent(customerText)) return text;
  const contacts = config.escalationContacts || [];
  if (!contacts.length) return text;                 // لا جهة تصعيد مضبوطة
  const name = contacts[0].name || 'المالك';
  const summary = String(customerText || '').slice(0, 40).replace(/[|\]]/g, ' ').trim();
  return `${text.trim()} [تحويل:${name}|${summary}]`;
}

// عبارات التهرّب الصريحة — مقيّدة بحدود توكن لتجنّب المطابقة الكاذبة
// "من المختص" مقيّدة: لا تتبعها حروف عربية (لتجنّب "من المختصر")
// "تسمح لي" حُذفت منفردة (واسعة جداً) — تبقى تُغطّى ضمن سياق التهرّب مع "من المختص"
const COPOUT = /(أأكد لك|اأكد لك|أتأكد لك|اتأكد لك|بسأل المختص|اسأل المختص|بسأل المسؤول|أرجع لك بأقرب|من المختص(?:[^ء-ي]|$))/;

function isCopOut(reply) {
  return COPOUT.test(String(reply || ''));
}

// تهرّب رغم وجود سياسة مطابقة بدرجة عالية = يحتاج إصلاح (إعادة توليد بحقن الجواب)
function needsRepairForCopOut(reply, matched = []) {
  return isCopOut(reply) && Array.isArray(matched) && matched.some(m => m.score >= 3);
}

// المنسّق: إصلاحات حتمية أولاً، ثم إعادة توليد واحدة عند تهرّب رغم سياسة مطابقة.
async function validateAndRepair({ reply, config = {}, customerText = '', matched = [], regenerate } = {}) {
  let current = String(reply || '').trim();
  const maxLen = config.maxResponseLength;

  // 1) إعادة توليد واحدة عند التهرّب رغم سياسة مطابقة
  if (needsRepairForCopOut(current, matched) && typeof regenerate === 'function') {
    try {
      const repaired = String(await regenerate() || '').trim();
      if (repaired && !isCopOut(repaired)) current = repaired;  // اقبل الأفضل فقط
    } catch { /* أبقِ الأصل */ }
  }

  // 2) إصلاحات حتمية (لا تحتاج نموذجاً)
  // حدّد العلامة النهائية (من النموذج إن وُجدت، أو حتمياً عند النية)
  const tagged = enforceEscalationTag(current, config, customerText);
  const tagMatch = tagged.match(/\s*\[تحويل:[^\]]*\]\s*$/);
  const tag = tagMatch ? tagMatch[0].trim() : '';
  const body = tagMatch ? tagged.slice(0, tagMatch.index).trim() : tagged;
  const trimmedBody = enforceLength(body, maxLen);   // القصّ على المتن فقط
  current = tag ? `${trimmedBody} ${tag}` : trimmedBody;
  return current;
}

module.exports = {
  enforceLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair,
};
