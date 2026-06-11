'use strict';

const { tokenize } = require('./knowledge-retrieval');

// الحد الفعّال للطول: سؤال واحد = الحد كما هو، أسئلة متعددة (علامات استفهام
// أو دفعة رسائل مجمّعة) = الحد × عدد الإشارات بسقف 3×. السبب (إنتاج
// 2026-06-11): حد 100 حرف كان يقصّ الجواب بعد التحية ويترك أسئلة العميل
// الحقيقية بلا رد، ورسالة فيها 3 أسئلة كانت تاخذ جواب سؤال واحد.
function scaledMaxLength(maxLen, customerText = '') {
  const base = Math.max(40, parseInt(maxLen, 10) || 300);
  const text = String(customerText || '');
  const marks = (text.match(/[؟?]/g) || []).length;
  const batched = text.includes('رسائل العميل المتتالية') ? 1 : 0;
  const signals = Math.min(3, Math.max(marks, 1) + batched);
  return base * signals;
}

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

// عبارات يقولها البوت نفسه وتدل على نية تحويل للفريق/الفني. كثير من برومبتات
// التجار تأمر البوت يقول "رح أحوّل طلبك للفريق" بالعربي، بدون علامة [تحويل:]
// — فيظن العميل أنه حُوّل بينما المالك لا يتبلّغ إطلاقاً. نكشف هذي العبارات
// ونضيف العلامة تلقائياً ليُشغَّل التصعيد الفعلي.
const BOT_TRANSFER_RE = /أحوّل|أحول|احوّل|احول|نحوّل|نحول|حوّلت طلبك|يتواصلون معك|بيتواصلون معك|يتواصل معك|بيتواصل معك/;

function botSignalsTransfer(reply) {
  return BOT_TRANSFER_RE.test(String(reply || ''));
}

function enforceEscalationTag(reply, config = {}, customerText = '') {
  const text = String(reply || '');
  if (/\[تحويل:/.test(text)) return text;            // النموذج وضعها
  // صعّد إذا طلب العميل صراحةً موظفاً، أو إذا قال البوت نفسه إنه يحوّل للفريق.
  if (!detectEscalationIntent(customerText) && !botSignalsTransfer(text)) return text;
  const contacts = config.escalationContacts || [];
  if (!contacts.length) return text;                 // لا جهة تصعيد مضبوطة
  const name = contacts[0].name || 'المالك';
  const summary = (String(customerText || '').slice(0, 40).replace(/[|\]]/g, ' ').trim()) || 'طلب عميل يحتاج متابعة';
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

// يمسك عبارة "عرض الخدمة" الآلية مهما التفّ النموذج لفظياً
// (أساعدك/أخدمك/أعاونك/مساعدتك/خدمتك)، حتمياً قبل الإرسال.
// ملاحظة: تم توسيع البادئة لتشمل (م) لالتقاط الصيغ المصدرية (مساعدتك، معاونتك)
// مقارنة بالخطة الأصلية، دون إضافة false positives (اختبر بشمول على 8+ حالات).
const OFFER_HELP = /\s*،?\s*(?:كيف|كيفاش|وش)\s+(?:أقدر|اقدر|يمكنني|ممكن|تحب|تبي)?\s*(?:أ|ا|م)?(?:ساعد|خدم|عاون)\S*\s*(?:اليوم|حضرتك)?\s*[؟?]*/g;

function stripStyleViolations(reply) {
  let out = String(reply || '').replace(OFFER_HELP, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([،.!؟])/g, '$1').trim();
  // نظّف علامة ترقيم متدلية في النهاية (مثل "! ," بعد الحذف)
  out = out.replace(/[،,]\s*$/, '').replace(/!\s*$/, '!').trim();
  return out;
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
  // فلتر أسلوب حتمي (يمسح عبارات عرض الخدمة الآلية)
  current = stripStyleViolations(current);
  current = enforceStyleRules(current, config);

  // حدّد العلامة النهائية (من النموذج إن وُجدت، أو حتمياً عند النية)
  const tagged = enforceEscalationTag(current, config, customerText);
  const tagMatch = tagged.match(/\s*\[تحويل:[^\]]*\]\s*$/);
  const tag = tagMatch ? tagMatch[0].trim() : '';
  const body = tagMatch ? tagged.slice(0, tagMatch.index).trim() : tagged;
  const trimmedBody = enforceLength(body, scaledMaxLength(maxLen, customerText));   // القصّ على المتن فقط
  current = tag ? `${trimmedBody} ${tag}` : trimmedBody;
  return current;
}

// نطاق إيموجي واسع (رموز + متغيرات + أعلام + ZWJ)
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu;

// يفرض ضوابط أسلوب التاجر المختارة فقط (config-driven، آمن متعدد المستأجرين).
function enforceStyleRules(reply, config = {}) {
  const r = (config && config.replyStyle) || {};
  let out = String(reply || '');
  if (r.emojiLevel === 'none') out = out.replace(EMOJI_RE, '');
  if (r.allowExclamation === false) out = out.replace(/[!！]/g, '');
  if (r.allowSentencePeriods === false) {
    // احذف النقطة المنهية لجملة (مسبوقة بحرف غير رقمي، يتبعها مسافة/سطر/نهاية)،
    // دون المساس بالنقطة العشرية (3.5) أو داخل الروابط (.com).
    out = out.replace(/([^\d\s])\.(?=\s|$)/g, '$1');
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([،؟])/g, '$1').trim();
  return out;
}

module.exports = {
  enforceLength, scaledMaxLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair, stripStyleViolations,
  enforceStyleRules, botSignalsTransfer,
};
