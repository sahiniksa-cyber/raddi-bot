'use strict';

const { normalizeArabic } = require('../../../lib/post-process-reply');

// كلمات وقف عربية شائعة لا تفيد في المطابقة
const STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','مع','هل','كم','ما','ماذا','وش','ايش','هذا','هذه',
  'ال','او','أو','و','يا','اي','أي','كل','عندكم','عندك','فيه','به','لو','لي','لك',
]);

// مجموعات مرادفات متناظرة (بعد التطبيع)
const SYN_GROUPS = [
  ['شحن','توصيل','توصل','يوصل','يوصلني','شحنه','ديليفري','يجي'],
  ['دفع','كاش','نقد','نقدا','فيزا','مدي','ادفع','تحويل','سداد'],
  ['ارجاع','استرجاع','ارجع','استبدال','تبديل','يرجع','ترجعون','بدل','رد'],
  ['حجز','احجز','طاوله','موعد','احجزون','احجزلي'],
  ['ضمان','مضمون','كفاله','يضمن'],
  ['تغليف','هديه','كرت','بطاقه','يغلف','تغلفون'],
  ['مخزون','ستوك','متوفر','موجود','متاح'],
  ['مواقف','موقف','باركنج'],
];

const TOKEN_TO_GROUP = new Map();
SYN_GROUPS.forEach((group, idx) => {
  group.forEach(tok => {
    if (!TOKEN_TO_GROUP.has(tok)) TOKEN_TO_GROUP.set(tok, new Set());
    TOKEN_TO_GROUP.get(tok).add(idx);
  });
});

function tokenize(text) {
  return normalizeArabic(String(text || ''))
    .toLowerCase()
    .split(/[^a-zء-ۿ]+/i)   // ء = first Arabic LETTER; excludes ؀-؛؟ punctuation so "مضمون؟" → "مضمون"
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function expandWithSynonyms(tokens) {
  const out = new Set(tokens);
  for (const tok of tokens) {
    // طبّق stripAl على التوكن نفسه حتى تنجح المطابقة مع مفاتيح TOKEN_TO_GROUP (بدون "ال")
    const bare = stripAl(tok);
    const groups = TOKEN_TO_GROUP.get(bare);
    if (!groups) continue;
    out.add(bare); // أضف الصيغة بدون "ال" حتى تُقارَن مع المرادفات
    for (const gi of groups) {
      for (const syn of SYN_GROUPS[gi]) out.add(syn);
    }
  }
  return out;
}

// إزالة أداة التعريف "ال" من أول التوكن (للمطابقة مع المرادفات بدونها)
function stripAl(tok) {
  return tok.startsWith('ال') && tok.length > 2 ? tok.slice(2) : tok;
}

// الدرجة: تطابق مع المفتاح يساوي 3 نقاط لكل توكن، ومع نص الرد نقطة واحدة.
function scorePolicy(customerText, keyword, reply) {
  const customer = expandWithSynonyms(tokenize(customerText));
  const kwTokens = tokenize(keyword);
  const replyTokens = tokenize(reply);
  let score = 0;
  for (const kt of kwTokens) if (customer.has(kt) || customer.has(stripAl(kt))) score += 3;
  for (const rt of new Set(replyTokens)) if ((customer.has(rt) || customer.has(stripAl(rt))) && !kwTokens.includes(rt)) score += 1;
  return score;
}

const MAX_INJECTED = 6;     // سقف الكتلة
const SCORE_THRESHOLD = 3;  // أقل درجة تعتبر "مطابقة"
const SMALL_SET = 8;        // أقل من هذا: احقن الكل عند عدم وجود مطابقة
const LARGE_SET = 20;       // أكثر من هذا: احقن المطابقات فقط

const CONSTRAINT = 'مهم: هذه سياسات عامة فقط (شحن/دفع/إرجاع/حجز/أوقات/رسوم). مواصفات المنتجات وتوافقها وأي ميزة تقنية تبقى خاضعة لقاعدة عدم الاختراع — لا تجزم بميزة غير مذكورة صراحة في قائمة المنتجات.';

function buildBlock(replies) {
  if (!replies.length) return '';
  const lines = replies.map(r => `- ${r}`).join('\n');
  return `\n\n<سياسات_المتجر_الجاهزة>\nهذه سياسات عامة كتبها صاحب المتجر. إن خصّ سؤال العميل أياً منها، اعتمدها كمصدر حقيقة وصُغها بأسلوبك القصير، ولا تقل "بسأل المختص" لمعلومة موجودة هنا.\n${CONSTRAINT}\n${lines}\n</سياسات_المتجر_الجاهزة>`;
}

function retrieveRelevantPolicies(config = {}, customerText = '') {
  const manualEntries = Object.entries(config.autoReplyKeywords || {})
    .map(([keyword, reply]) => ({ keyword: String(keyword || '').trim(), reply: String(reply || '').trim() }))
    .filter(e => e.keyword && e.reply);

  // Learned replies (phase-1 self-learning): Q→A pairs harvested from the
  // owner's own manual replies. Deliberately a SEPARATE config key — merging
  // into autoReplyKeywords would also trigger instant-reply keyword matching.
  const learnedEntries = (Array.isArray(config.learnedReplies) ? config.learnedReplies : [])
    .map(e => ({ keyword: String(e?.keyword || '').trim(), reply: String(e?.reply || '').trim() }))
    .filter(e => e.keyword && e.reply);

  if (!manualEntries.length && !learnedEntries.length) return { block: '', matched: [] };

  const scoreOf = e => ({ ...e, score: scorePolicy(customerText, e.keyword, e.reply) });
  const scoredManual = manualEntries.map(scoreOf).sort((a, b) => b.score - a.score);
  const scoredLearned = learnedEntries.map(scoreOf).sort((a, b) => b.score - a.score);

  // Learned entries inject ONLY on a real match. The zero-score fallbacks
  // (small-set inject-all / medium-set top-N) apply to the merchant's MANUAL
  // policies only — a learned mid-conversation pair injected without a match
  // made the bot send a stale verification code to the wrong customer
  // (production 2026-06-11).
  const matched = [...scoredManual, ...scoredLearned]
    .filter(e => e.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  let selected;
  if (matched.length) {
    selected = matched.slice(0, MAX_INJECTED);
  } else if (scoredManual.length && scoredManual.length <= SMALL_SET) {
    selected = scoredManual;            // مجموعة صغيرة: احقن الكل (آمن ورخيص)
  } else if (scoredManual.length && scoredManual.length <= LARGE_SET) {
    selected = scoredManual.slice(0, MAX_INJECTED); // متوسطة: أعلى درجات
  } else {
    selected = [];                      // كبيرة جداً بلا مطابقة: لا تحقن (تشويش/تكلفة)
  }

  return {
    block: buildBlock(selected.map(e => e.reply)),
    matched: matched.map(e => ({ keyword: e.keyword, reply: e.reply, score: e.score })),
  };
}

module.exports = { tokenize, scorePolicy, expandWithSynonyms, retrieveRelevantPolicies };
