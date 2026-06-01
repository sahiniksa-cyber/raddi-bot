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
    short: `قصير ومباشر، غالباً جملة إلى جملتين، ولا يتجاوز ${maxLen} حرف إلا للضرورة`,
    medium: `متوسط وواضح، يجاوب السؤال بدون حشو، ولا يتجاوز ${maxLen} حرف قدر الإمكان`,
    long: `مفصل عند الحاجة، خصوصاً عند شرح خيارات أو أسعار، مع الالتزام بحد ${maxLen} حرف قدر الإمكان`,
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

  return `\n\n---\n📋 إعدادات المنصة الملزمة (استخدمها كلها مع تعليمات المالك، وليست مجرد معلومات ثانوية):\n- اسم المتجر: ${config.storeName || 'المتجر'}\n- وصف المتجر: ${config.storeDescription || '—'}\n- ساعات العمل: ${config.workingHours || '—'}\n- اسم الموظف/الشخصية: ${employeeName}\n- نبرة الرد: ${tone}\n- لغة الرد: ${language}\n- طول الرد المثالي: ${replyLength}\n- معدل الإيموجي: ${emoji}\n- عبارات ترحيب ممكنة: ${greetings}\n- عبارات إنهاء ممكنة: ${closings}\n- كلمات أو عبارات ممنوعة: ${forbidden}\n- المنتجات الموجودة في المنصة:\n${productsBlock || '—'}${productContext ? `\n- المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}\n- عند التعارض: معلومات المنتجات والأسعار وحقول المنصة وتعليمات المالك هي مصدر الحقيقة. لا تعتمد على الذاكرة العامة ولا تخترع معلومة ناقصة.\n- طبّق هذه الخيارات في كل رد: اللغة، اللهجة، طول الرد، الإيموجي، النبرة، الترحيب، والخاتمة المناسبة.\n- تعليمات المالك ووصف المتجر أعلى أولوية مطلقة: اتبعها حرفياً في الأسلوب والتنسيق والمحتوى، وإذا منع المالك شيئاً (مثل النقاط أو عبارات معيّنة) فلا تستخدمه إطلاقاً.\n- أسلوب الكتابة افتراضياً رسائل واتساب طبيعية بجُمل متصلة: ممنوع التعداد النقطي (•، -، *) أو ترقيم القوائم أو العناوين أو أي تنسيق ماركداون، إلا إذا طلب المالك ذلك صراحةً في تعليماته.`;
}

module.exports = {
  buildPlatformPromptBlock,
  describeEmoji,
  describeLanguage,
  describeReplyLength,
  findAutoReply,
};
