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
  // Brevity authority: the dashboard maxResponseLength is the ceiling. Multi-
  // question messages still get room (so a 2nd question isn't truncated — the
  // 2026-06-11 fix) but capped at 2x, not 3x, so replies stay near the owner's
  // configured length instead of ballooning. Flag-gated (default keeps 3x).
  const cap = process.env.BREVITY_AUTHORITY_ENABLED === 'true' ? 2 : 3;
  const signals = Math.min(cap, Math.max(marks, 1) + batched);
  return base * signals;
}

// قصّ الرد على حدّ الطول، مفضّلاً نهاية جملة كاملة قبل الحدّ.
function enforceLength(reply, maxLen) {
  const text = String(reply || '').trim();
  const limit = Math.max(40, parseInt(maxLen, 10) || 300);
  if (text.length <= limit) return text;

  // Never truncate a reply that carries a link: cutting mid-URL — or at the dot
  // inside "prostoree.com" (lastIndexOf('.') treated it as a sentence end) —
  // produced the broken "https://prostoree." (production 2026-07-02). Product
  // cards with a subscription link are sent whole.
  if (/https?:\/\/\S+/i.test(text)) return text;

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
  return hasWant && hasHuman || customerRequestedEscalation(customerText);
}

// طلب صريح من العميل بإرسال/تبليغ الفريق ("ارسل للادارة مرة ثانية"، "بلغ
// الإدارة"، "كلم الدعم") — إنتاج 2026-06-12: البوت قال "تبشر" وما صعّد.
// نفس مبدأ الاقتران الثنائي: فعل طلب + جهة، لمنع الإنذارات الكاذبة.
const CUSTOMER_ESC_VERB = '(?:أ?رسل|بلّ?غ|أبلغ|ابلغ|صعّ?د|حوّ?ل|ارفع|كلّ?م|تواصل(?:وا)?\\s*مع|وصّ?ل)';
const CUSTOMER_ESC_ENTITY = '(?:لل|ال|مع\\s*ال)?(?:[إا]دارة|فريق|مختص(?:ين)?|مسؤول(?:ين)?|دعم|قسم|موظف(?:ين)?|مالك|مدير)';
const CUSTOMER_ESC_REQUEST_RE = new RegExp(`${CUSTOMER_ESC_VERB}[^\\n.؟!]{0,20}${CUSTOMER_ESC_ENTITY}`);

function customerRequestedEscalation(customerText) {
  return CUSTOMER_ESC_REQUEST_RE.test(String(customerText || ''));
}

// عبارات يقولها البوت نفسه وتدل على نية تحويل للفريق/الفني. كثير من برومبتات
// التجار تأمر البوت يقول "رح أحوّل طلبك للفريق" بالعربي، بدون علامة [تحويل:]
// — فيظن العميل أنه حُوّل بينما المالك لا يتبلّغ إطلاقاً. نكشف هذي العبارات
// ونضيف العلامة تلقائياً ليُشغَّل التصعيد الفعلي.
const BOT_TRANSFER_RE = /أحوّل|أحول|احوّل|احول|نحوّل|نحول|حوّلت طلبك|يتواصلون معك|بيتواصلون معك|يتواصل معك|بيتواصل معك/;

// إنتاج 2026-06-11/12: النموذج ادّعى التحويل بصيغ خارج القائمة أعلاه
// ("رسلت للإدارة"، "حولتك للفريق المختص") فلم تُفرض العلامة ولم يصل شيء
// للفريق. النمط الموسّع = فعلُ تحويل/إبلاغ قريبٌ من جهة (الإدارة/الفريق/
// المختص/الدعم...) — الاقتران الثنائي يمنع الإنذارات الكاذبة ("أرسلت لك
// الكود" بلا جهة، "الإدارة ترحب بك" بلا فعل).
// صيغ الماضي + المستقبل (رح/راح/بـ/سـ/سوف + أبلغ/أرسل/أحول/أرفع/أصعد) —
// إنتاج 2026-06-12 22:18: "رح أبلغ الإدارة" فاتت قائمة الماضي فلم يُصعَّد
// والعميل تُرك ينتظر إدارة لا تعلم به.
const TRANSFER_VERB = '(?:حوّ?لت(?:ك|كم|نا|ها)?|تم\\s*(?:تحويل|رفع|إبلاغ|ابلاغ|التصعيد|تصعيد)|أ?رسلت|رفعت|بلّ?غت|أبلغت|ابلغت|صعّ?دت|(?:رح|راح|ب|س|سوف)\\s*[أان]?(?:بلّ?غ|رسل|حوّ?ل|رفع|صعّ?د))';
const TRANSFER_ENTITY = '(?:لل|ال)?(?:[إا]دارة|فريق|مختص(?:ين)?|مسؤول(?:ين)?|دعم|قسم|موظف(?:ين)?)';
const BOT_TRANSFER_CLAIM_RE = new RegExp(`${TRANSFER_VERB}[^\\n.؟!]{0,25}${TRANSFER_ENTITY}`);

// إنتاج 2026-06-12 (~16:10): العميل وصف مشكلة كانفا والبوت وعد "بنحل لك
// المشكلة" — ولا انطلق تصعيد حتى ألحّ العميل. وعد بصيغة المتكلم (بنحل/سنحل)
// = التزام يستلزم الفريق → صعّد عند المشكلة فوراً. "تقدر تحل المشكلة بنفسك"
// (إرشاد للعميل بصيغة المخاطَب) لا يطابق.
const BOT_FIX_PROMISE_RE = /(?:^|\s)(?:بنحل|نحل|سنحل|راح\s*نحل|بنحلها|نحلها)\s*(?:لك|لكم)?[^\n.؟!]{0,12}(?:المشكلة|المشكله|مشكلتك|مشكلتكم)/;

function botSignalsTransfer(reply) {
  const text = String(reply || '');
  return BOT_TRANSFER_RE.test(text) || BOT_TRANSFER_CLAIM_RE.test(text) || BOT_FIX_PROMISE_RE.test(text);
}

// الرد يطلب من العميل معلومة (إيميل/رقم طلب/بيانات) = البوت يعالج بنفسه،
// فالتصعيد التلقائي في نفس الرسالة يناقضه. (طلب العميل الصريح لموظف يتجاوز هذا.)
const ASK_CUSTOMER_INFO_RE = /(الإيميل|الايميل|البريد|رقم الطلب|رقم الجوال|رقمك|بياناتك|بيانات حسابك|رقم العملية|اسم المستخدم|المبلغ المحوّل|رقم الحساب)/;
function replyAsksCustomerForInfo(reply) {
  const t = String(reply || '');
  return ASK_CUSTOMER_INFO_RE.test(t) && /[؟?]/.test(t);
}

function enforceEscalationTag(reply, config = {}, customerText = '') {
  const text = String(reply || '');
  if (/\[تحويل:/.test(text)) return text;            // النموذج وضعها
  const explicit = detectEscalationIntent(customerText);
  // صعّد إذا طلب العميل صراحةً موظفاً، أو قال البوت إنه يحوّل للفريق، أو تهرّب
  // بوعدٍ بالمراجعة/العودة ("بأراجع وأكلمك") — وإلا يبقى العميل معلّقاً بلا أحد.
  if (!explicit && !botSignalsTransfer(text) && !isCopOut(text)) return text;
  // لا تصعيد تلقائي بينما البوت يجمع معلومة من العميل (تناقض «اطلب الإيميل» + «نحوّل للمختص»).
  // طلب العميل الصريح لموظف يبقى يُصعّد.
  if (!explicit && replyAsksCustomerForInfo(text)) return text;
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

// إنتاج 2026-06-15: العائلة الأكثر شيوعاً للتهرّب كانت تفلت من COPOUT أعلاه —
// "راجِع/تحقّق ثم أرجع/أكلمك لاحقاً" ("بأراجع الموضوع وأكلمك"، "لحظات أراجع
// وأكلمك"، "أراجع المختص ويرجع لك"). نشترط فعل مراجعة + وعد بالعودة خلال حدود
// توكن قصيرة لمنع الإنذار الكاذب على إجابة حقيقية ("أرجع لك السعر هو 250").
const COPOUT_DEFLECT = /(?:أراجع|اراجع|راجع|أتحقق|اتحقق|أستفسر|استفسر|أشوف|اشوف)[^\n.؟!]{0,30}(?:أكلمك|اكلمك|أرجع لك|ارجع لك|يرجع لك|أرد عليك|ارد عليك|أبلغك|ابلغك|أفيدك|افيدك|نتواصل|أتواصل معك)/;

function isCopOut(reply) {
  const text = String(reply || '');
  return COPOUT.test(text) || COPOUT_DEFLECT.test(text);
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
  enforceStyleRules, botSignalsTransfer, customerRequestedEscalation,
};
