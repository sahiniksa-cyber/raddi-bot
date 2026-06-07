'use strict';

function isShortGreetingLikeKeyword(keyword) {
  const tokens = keyword.split(/\s+/).filter(Boolean);
  return tokens.length === 1 && keyword.length <= 8;
}

function findAutoReply(config = {}, text = '') {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return '';
  const messageWordCount = lower.split(/\s+/).filter(Boolean).length;

  for (const [keyword, reply] of Object.entries(config.autoReplyKeywords || {})) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    const normalizedReply = String(reply || '').trim();
    if (!normalizedKeyword || !normalizedReply) continue;
    if (!lower.includes(normalizedKeyword)) continue;
    // كلمات قصيرة مفردة (تحيات مثل "السلام"، "hi") لا تختطف رسالة طويلة فيها سؤال.
    if (isShortGreetingLikeKeyword(normalizedKeyword) && messageWordCount > 3) continue;
    return normalizedReply;
  }

  return '';
}

function describeLanguage(config = {}) {
  const r = config.replyStyle || {};
  if (config.responseLanguage) return String(config.responseLanguage).trim();
  if (r.useDialect === false) {
    if (r.languageStyle === 'formal') return 'الفصحى الرسمية';
    return 'الفصحى السهلة';
  }
  return r.dialect || 'السعودية الخفيفة';
}

function describeEmoji(level = 'medium') {
  return {
    none: 'بدون إيموجي نهائياً',
    light: 'إيموجي قليل جداً، عند الحاجة فقط',
    medium: 'إيموجي معتدل، إيموجي واحد عند الحاجة',
    heavy: 'إيموجي واضح، 2-3 عند مناسبة الرد',
  }[level] || 'إيموجي معتدل، إيموجي واحد عند الحاجة';
}

function describeReplyLength(config = {}) {
  const r = config.replyStyle || {};
  const maxLen = Math.max(80, parseInt(config.maxResponseLength, 10) || 300);
  const map = {
    short: `جملة إلى جملتين قصيرتين فقط (لا تتجاوز ${maxLen} حرف). جاوب على قدّ السؤال تماماً مثل موظف بشري يكتب بسرعة على واتساب — بدون مقدمات، بدون شرح زائد، بدون تكرار. لا تعطِ معلومات ما طلبها العميل.`,
    medium: `جملتان إلى ثلاث جمل قصيرة كحد أقصى (لا تتجاوز ${maxLen} حرف). جاوب السؤال مباشرة بأسلوب بشري بدون حشو ولا تكرار.`,
    long: `مفصّل فقط عند الحاجة الحقيقية (شرح خيارات أو أسعار)، وبأقصر صياغة بشرية ممكنة دون تجاوز ${maxLen} حرف.`,
  };
  return map[r.replyLength] || (r.useShortReplies ? map.short : map.medium);
}

function listOrFallback(items, fallback) {
  return Array.isArray(items) && items.filter(Boolean).length ? items.filter(Boolean).join('، ') : fallback;
}

function buildPlatformPromptBlock(config = {}, {
  productsBlock = '',
  productContext = '',
  avoid = '',
} = {}) {
  const r = config.replyStyle || {};
  const employeeName = r.employeeName || 'موظف خدمة العملاء';
  const tone = r.tone || 'ودي ومحترم';
  const language = describeLanguage(config);
  const emoji = describeEmoji(r.emojiLevel || 'medium');
  const replyLength = describeReplyLength(config);
  const greetings = listOrFallback(r.greetingPhrases, 'رحّب بشكل طبيعي بدون تكرار أو مبالغة');
  const closings = listOrFallback(r.closingPhrases, 'اختم فقط إذا كان مناسباً ولا تكرر الخاتمة في كل رد');
  const forbidden = avoid || listOrFallback(r.avoidWords, 'AI، ذكاء اصطناعي، نموذج لغة، روبوت، ChatGPT، Claude');

  return `\n\n---\n📋 إعدادات المنصة الملزمة (استخدمها كلها مع تعليمات المالك، وليست مجرد معلومات ثانوية):\n- اسم المتجر: ${config.storeName || 'المتجر'}\n- وصف المتجر: ${config.storeDescription || '—'}\n- ساعات العمل: ${config.workingHours || '—'}\n- اسم الموظف/الشخصية: ${employeeName}\n- نبرة الرد: ${tone}\n- لغة الرد: ${language}\n- 🔑 طول الرد (قاعدة صارمة التزم بها حرفياً في كل رد): ${replyLength}\n- معدل الإيموجي: ${emoji}\n- عبارات ترحيب ممكنة: ${greetings}\n- عبارات إنهاء ممكنة: ${closings}\n- كلمات أو عبارات ممنوعة: ${forbidden}\n- المنتجات الموجودة في المنصة:\n${productsBlock || '—'}${productContext ? `\n- المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}\n- عند التعارض: معلومات المنتجات والأسعار وحقول المنصة وتعليمات المالك هي مصدر الحقيقة. لا تعتمد على الذاكرة العامة ولا تخترع معلومة ناقصة.\n- طبّق هذه الخيارات في كل رد: اللغة، اللهجة، طول الرد، الإيموجي، النبرة، الترحيب، والخاتمة المناسبة.\n- تعليمات المالك ووصف المتجر أعلى أولوية مطلقة: اتبعها حرفياً في الأسلوب والتنسيق والمحتوى، وإذا منع المالك شيئاً (مثل النقاط أو عبارات معيّنة) فلا تستخدمه إطلاقاً.\n- أسلوب الكتابة افتراضياً رسائل واتساب طبيعية بجُمل متصلة: ممنوع التعداد النقطي (•، -، *) أو ترقيم القوائم أو العناوين أو أي تنسيق ماركداون، إلا إذا طلب المالك ذلك صراحةً في تعليماته.`;
}

function collectInstantReplies(config = {}, text = '') {
  const lower = String(text || '').toLowerCase().trim();
  const matched = [];
  if (!lower) return { matched, hasExtraQuestion: false };
  let remainder = lower;
  for (const [keyword, reply] of Object.entries(config.autoReplyKeywords || {})) {
    const k = String(keyword || '').trim().toLowerCase();
    const r = String(reply || '').trim();
    if (!k || !r) continue;
    if (!lower.includes(k)) continue;
    matched.push({ keyword: k, reply: r });
    remainder = remainder.split(k).join(' ');
  }
  remainder = remainder.replace(/\s+/g, ' ').trim();
  const meaningful = remainder
    ? remainder.split(/\s+/).filter(w => w.replace(/[^؀-ۿa-z0-9]/gi, '').length >= 2)
    : [];
  // Question/request token detection: exact token match so "كيف" inside "كيفك" won't fire.
  const QUESTION_TOKENS = new Set([
    'كم', 'بكم', 'وش', 'ايش', 'أيش', 'متى', 'كيف', 'هل', 'وين', 'اين', 'أين',
    'ليش', 'لماذا', 'ابي', 'أبي', 'ابغى', 'أبغى', 'ابغا',
    'عندكم', 'عندك', 'تبيعون', 'متوفر',
  ]);
  const remainderTokens = remainder ? remainder.split(/\s+/).filter(Boolean) : [];
  const hasQuestionMark = /[؟?]/.test(remainder);
  const hasQuestionToken = remainderTokens.some(t => QUESTION_TOKENS.has(t.replace(/[^؀-ۿa-z]/gi, '')));
  const hasExtraQuestion = matched.length > 0 && (hasQuestionMark || hasQuestionToken || meaningful.length >= 2);
  return { matched, hasExtraQuestion };
}

// Opening greeting/salutation in an AI reply. Used to avoid duplicating the
// greeting when a canned greeting instant-reply is already prepended in combine
// mode (the AI tends to also greet, producing "وعليكم السلام ... وعليكم السلام").
const GREETING_OPENER = /^[\s،,!.⁩⁦]*(?:(?:و\s*)?عليكم\s*السلام|(?:ال)?سلام\s*عليكم(?:\s*ورحمة\s*الله(?:\s*وبركاته)?)?|أهلين|اهلين|أهلاً|اهلا|مرحبتين|مرحبا|مرحباً|هلا\s*والله|هلا\s*بك|هلا|حيّاك\s*الله|حياك\s*الله|حياك|يا\s*هلا|صباح\s*الخير|مساء\s*الخير)[\s،,!.؟…]*/i;

// Combine a verbatim canned instant-reply (e.g. a greeting) with the AI's
// answer WITHOUT duplicating the greeting: strip any leading greeting from the
// AI part, then prepend the canned text. Pure + deterministic.
function combineCannedAndAi(cannedPrefix, aiReply) {
  const canned = String(cannedPrefix || '').trim();
  let ai = String(aiReply || '').trim();
  if (!canned) return ai;
  // Strip ALL stacked leading greetings (the AI sometimes greets more than once).
  let prev;
  do { prev = ai; ai = ai.replace(GREETING_OPENER, '').trim(); } while (ai && ai !== prev);
  if (!ai || ai === canned) return canned;
  return `${canned}\n${ai}`;
}

module.exports = {
  buildPlatformPromptBlock,
  collectInstantReplies,
  combineCannedAndAi,
  describeEmoji,
  describeLanguage,
  describeReplyLength,
  findAutoReply,
};
