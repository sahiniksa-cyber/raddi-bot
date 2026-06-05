'use strict';

// قصّ الرد على حدّ الطول، مفضّلاً نهاية جملة كاملة قبل الحدّ.
function enforceLength(reply, maxLen) {
  const text = String(reply || '').trim();
  const limit = Math.max(10, parseInt(maxLen, 10) || 300);
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

const WANT = /(يبي|يبغى|أبي|ابي|ودي|أبغى|ابغى|أحتاج|احتاج|ممكن أكلم|اكلم|اتواصل)/;
const HUMAN = /(موظف|مختص|مسؤول|مسئول|إنسان|انسان|بشر|المدير|المالك|صاحب المحل|احد)/;

function detectEscalationIntent(customerText) {
  const t = String(customerText || '');
  return WANT.test(t) && HUMAN.test(t);
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

const COPOUT = /(أأكد لك|اأكد لك|أتأكد لك|اتأكد لك|بسأل المختص|اسأل المختص|بسأل المسؤول|أرجع لك بأقرب|تسمح لي|من المختص)/;

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
  current = enforceEscalationTag(current, config, customerText);
  current = enforceLength(current, maxLen);
  return current;
}

module.exports = {
  enforceLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair,
};
