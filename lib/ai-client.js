/**
 * lib/ai-client.js — AI Provider Abstraction
 *
 * مسؤوليات:
 *   1. بناء OpenAI Client حسب الموديل المختار (Gemini/Claude/GPT/OpenRouter)
 *   2. بناء System Prompt مع معلومات المتجر والتصعيد
 *   3. استدعاء الـ AI مع إعادة المحاولة (429) و Rate Limiting
 *   4. تسجيل التكاليف
 *
 * Usage:
 *   const ai = new AIClient(config, logger, costTracker);
 *   const reply = await ai.getReply(history, { isFirstMsg: true });
 */
'use strict';

const OpenAI = require('openai');
const { MODEL_PRICES, TIMERS } = require('./constants');
const { sleep } = require('./helpers');
const { buildRelevantProductContext } = require('../src/services/products/product-knowledge');
const { buildPlatformPromptBlock } = require('../src/services/bot/platform-features');
const { stripAvoidedContent } = require('./post-process-reply');
const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');
const { validateAndRepair } = require('../src/services/ai/reply-validator');

// ── Model resolution by available key ─────────────────────────────────
// buildClient() picks the provider from the model STRING, but a merchant/
// admin may hold a key for a DIFFERENT provider than the (often default)
// model implies — e.g. an OpenAI key with the Gemini default model. Rather
// than throwing (which silently drops the customer to the fallback reply),
// switch to a model the available key can actually serve. OpenRouter routes
// every model, so its presence keeps the configured model untouched.
const OPENAI_DEFAULT_MODEL = 'gpt-4o';
const GOOGLE_DEFAULT_MODEL = 'google/gemini-2.0-flash';

function resolveEffectiveModel(config = {}) {
  const model = config.model || GOOGLE_DEFAULT_MODEL;
  const hasOpenrouter = (config.openrouterApiKey || '').trim().length > 20;
  if (hasOpenrouter) return model;                       // OpenRouter routes any model
  const hasGoogle = (config.googleApiKey || '').trim().length > 10;
  const hasOpenai = (config.openaiApiKey || '').trim().length > 20;
  const isGoogle = model.startsWith('google/') || model.startsWith('gemini');
  const isOpenai = !model.includes('/') || model.startsWith('openai/');
  // Keep the model when its own provider key is present.
  if (isGoogle && hasGoogle) return model;
  if (isOpenai && hasOpenai) return model;
  // Otherwise switch to a model the key we DO have can serve.
  if (hasOpenai) return OPENAI_DEFAULT_MODEL;
  if (hasGoogle) return GOOGLE_DEFAULT_MODEL;
  return model;                                          // no key at all → buildClient throws a helpful error
}

class AIClient {
  /**
   * @param {object} config — إعدادات المستخدم (model, API keys, etc.)
   * @param {import('./logger')} logger
   * @param {object} costTracker — { data, record(model, inTokens, outTokens), save() }
   */
  constructor(config, logger, costTracker) {
    this.config = config;
    this.logger = logger;
    this.costTracker = costTracker;
    this.lastCallAt = 0;
    this.lastDebug = null;
  }

  /** تحديث المرجع للإعدادات (يُستدعى عند تغيير الإعدادات) */
  updateConfig(config) { this.config = config; }

  // ── Build OpenAI Client per model ──────────────────────────────────
  buildClient() {
    const model = resolveEffectiveModel(this.config);
    const c = this.config;

    // Google Gemini
    if (model.startsWith('google/') || model.startsWith('gemini')) {
      const direct = c.googleApiKey?.trim();
      const orKey = c.openrouterApiKey?.trim();
      if (direct && direct.length > 10) {
        return { openai: new OpenAI({ apiKey: direct, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }), model: model.replace('google/', '') };
      }
      if (orKey && orKey.length > 20) {
        return { openai: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://jwab.app', 'X-Title': 'جواب' } }), model };
      }
      throw new Error('أضف مفتاح Google AI (من aistudio.google.com) أو مفتاح OpenRouter');
    }

    // Anthropic Claude — يجب استخدام OpenRouter لأن Anthropic لا يدعم صيغة OpenAI Chat Completions مباشرة
    if (model.startsWith('anthropic/') || model.startsWith('claude')) {
      const orKey = c.openrouterApiKey?.trim();
      if (orKey && orKey.length > 20) {
        const orModel = model.startsWith('anthropic/') ? model : `anthropic/${model}`;
        return { openai: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://jwab.app', 'X-Title': 'جواب' } }), model: orModel };
      }
      const direct = c.anthropicApiKey?.trim();
      if (direct && direct.length > 10) {
        throw new Error('موديلات Claude تتطلب مفتاح OpenRouter (api endpoint توافقي). أضف مفتاح OpenRouter في الإعدادات، أو غيّر الموديل إلى Gemini/GPT.');
      }
      throw new Error('أضف مفتاح OpenRouter لاستخدام موديلات Claude (من openrouter.ai)');
    }

    // OpenAI GPT
    const isOpenAIModel = !model.includes('/') || model.startsWith('openai/');
    if (isOpenAIModel) {
      const actualModel = model.replace(/^openai\//, '');
      const openaiKey = c.openaiApiKey?.trim();
      const orKey = c.openrouterApiKey?.trim();
      if (openaiKey && openaiKey.length > 20) return { openai: new OpenAI({ apiKey: openaiKey }), model: actualModel };
      if (orKey && orKey.length > 20) {
        const orModel = model.startsWith('openai/') ? model : 'openai/' + model;
        return { openai: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://jwab.app', 'X-Title': 'جواب' } }), model: orModel };
      }
      throw new Error('أضف مفتاح OpenAI (من platform.openai.com) أو مفتاح OpenRouter كبديل');
    }

    // OpenRouter fallback
    const orKey = c.openrouterApiKey?.trim();
    if (orKey && orKey.length > 20) {
      return { openai: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://jwab.app', 'X-Title': 'جواب' } }), model };
    }

    // Last resort fallbacks
    const googleKey = c.googleApiKey?.trim();
    if (googleKey && googleKey.length > 10) {
      this.logger.warn('ai', `⚠️ مو في مفتاح لـ ${model} — يستخدم Gemini Flash كبديل`);
      return { openai: new OpenAI({ apiKey: googleKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }), model: 'gemini-2.0-flash' };
    }
    throw new Error('لا يوجد أي مفتاح API مضبوط — أضف مفتاحاً في الإعدادات (Gemini أو OpenAI أو OpenRouter)');
  }

  // ── System Prompt Builder ──────────────────────────────────────────
  buildSystemPrompt(history = [], opts = {}) {
    const r = this.config.replyStyle || {};
    const employeeName = r.employeeName || 'موظف خدمة العملاء';
    const avoid = r.avoidWords?.length ? r.avoidWords.join('، ') : 'AI، ذكاء اصطناعي، نموذج لغة، روبوت، ChatGPT، Claude';
    const customInstructions = String(this.config.botInstructions || '').trim();
    const hasLongCustomInstructions = customInstructions.length >= 80;
    const lastUserText = opts.latestUserText || [...history].reverse().find(m => m.role === 'user')?.content || '';
    const productContext = buildRelevantProductContext({ config: this.config, customerText: lastUserText });

    const knowledgeEnabled = process.env.KNOWLEDGE_INJECTION_ENABLED !== 'false';
    const policyBlock = knowledgeEnabled
      ? retrieveRelevantPolicies(this.config, lastUserText).block
      : '';

    const instantAnswered = String(opts.instantAnswered || '').trim();
    const instantBlock = instantAnswered
      ? `\n\n<أجزاء_سبق_الرد_عليها>\nالأجزاء التالية من رسالة العميل مُجاب عليها مسبقاً وستُرسل قبل ردك حرفياً:\n${instantAnswered}\nجاوب فقط على باقي رسالة العميل (بما فيها أي أسئلة إضافية) بدون تكرار ما سبق. إذا لم يبقَ شيء غير مُجاب، اكتفِ بجملة قصيرة مناسبة أو لا تضف.\n</أجزاء_سبق_الرد_عليها>`
      : '';

    const productsBlock = this.config.products?.length
      ? this.config.products.map((p, i) => {
          let head = `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`;
          const longDesc = String(p.longDescription || '').trim();
          if (longDesc) head += `\n   ${longDesc}`;
          const url = String(p.url || '').trim();
          if (url) head += `\n   الرابط: ${url}`;
          const variants = Array.isArray(p.variants)
            ? p.variants.filter(v => v && (String(v.label || '').trim() || String(v.price || '').trim()))
            : [];
          if (variants.length === 0) return head;
          const variantLines = variants
            .map(v => `   • ${String(v.label || '').trim() || '—'}: ${String(v.price || '').trim() || 'السعر عند الطلب'}`)
            .join('\n');
          return `${head}\n${variantLines}`;
        }).join('\n')
      : hasLongCustomInstructions
      ? 'لم تُدخل منتجات في حقول المنتجات المنفصلة. إذا كانت التعليمات أعلاه تحتوي منتجات أو أسعاراً فهي مصدر الحقيقة؛ لا تخترع أي منتج أو سعر غير مذكور.'
      : '(لا توجد منتجات مضافة بعد)';
    const knowledgeRules = `\n\nقواعد الدقة وعدم الهبد (إلزامية — اتباعها أهم من سرعة الرد):
- افهم نية العميل من رسالته كاملة أولاً وجاوب على كل أسئلته في ردّ واحد متماسك بدون أن تترك أي سؤال. القاعدة الوحيدة: لا تجمع لنفس الطلب بين طلب معلومة من العميل ووعدٍ بالتحويل/التصعيد (متناقضان). إن كانت نية العميل غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
- إذا بدأت رسالة العميل بتحية (مثل السلام عليكم، هلا، مرحبا) ثم سؤال أو أكثر، فرد على التحية بكلمة واحدة قصيرة ثم جاوب على كل الأسئلة في نفس الرسالة فوراً — لا تكتفِ بردّ التحية وتتجاهل الأسئلة إطلاقاً.
- إذا حوت رسالة العميل أكثر من سؤال أو طلب، جاوب على جميع الأسئلة في ردّك ولا تترك أي سؤال بدون إجابة.
- لا تعِد العميل بالتحويل أو إرسال طلبه للمختص إلا إذا كنت ستصعّد فعلاً ولا تطلب منه معلومة في نفس الرسالة. وإذا منع المالك عبارة معيّنة فلا تستخدمها ولا أي صياغة قريبة منها إطلاقاً.
- ممنوع تماماً اختراع أي منتج أو مدة أو سعر أو ضمان أو رابط أو ميزة غير مذكورة في التعليمات أو قائمة المنتجات أعلاه. لا تخمّن، لا تستنتج من أسماء المنتجات، لا تستخدم معلومة عامة من خارج المتجر.
- إذا سأل العميل عن شيء غير موجود لديك، استخدم البديل الآمن: "ودّي أأكد لك المعلومة من المختص قبل ما أعطيك جواب مؤكد، تسمح لي؟" — ثم استخدم تصعيداً إذا كان متاحاً، أو اطلب من العميل التواصل المباشر.
- لا تقل "بسأل المسؤول" ثم تخترع جواباً. إما تنتظر تأكيد التصعيد، أو ترد بما عندك فقط.
- عند تعارض المعلومات: التعليمات المكتوبة من المالك > قائمة المنتجات والأسعار > أي شيء آخر.
- ممنوع أي عبارة عرض خدمة عامة أو آلية (مثل "كيف أقدر أساعدك/أخدمك"، "كيف يمكنني مساعدتك"). بدلاً منها اسأل سؤالاً ملموساً عن طلب العميل أو ادخل في صلب الموضوع مباشرة.
- تصرّف كموظف بشري حقيقي يكتب على واتساب، لا كروبوت: نوّع صياغتك في كل رد، ولا تذكر أبداً أي منهجية أو أسماء أطر أو وسوم تقنية أو حد عدد أحرف.
- ممنوع إنهاء الرد بسؤال حشو متكرر مثل «تبي شي ثاني؟» أو «تأمر بشي ثاني؟» أو «أي شي ثاني؟ أنا هنا» أو «في خدمتك» إلا إذا كان هناك خطوة بيع/طلب مفتوحة فعلاً (اختيار خيار أو دفع أو تأكيد طلب). إذا أُجيب سؤال العميل بالكامل ولا يوجد قرار معلّق، اكتفِ بالجواب بدون أي سؤال إضافي. ولا تكرر نفس عبارة الإغلاق في ردّين متتاليين.
- إذا أبدى العميل ما يدل على الرضا أو إنهاء المحادثة (مثل: تمام، خلاص، شكراً، يعطيك العافية، تم، كفو، الله يعافيك)، فاعتبر طلبه مُنجزاً: اختم بعبارة شكر قصيرة واحدة متنوّعة بدون أي سؤال متابعة، ولا تفتح موضوعاً جديداً.
- لا تكرر نفس الجملة أو المعلومة داخل الرد الواحد، ولا تعيد ما قلته في ردودك السابقة بنفس الصياغة.
- افهم سؤال العميل فعلاً وقدّم له المعلومة أو الحل الدقيق؛ لا تكتفِ بعبارات مجاملة أو بإعادة صياغة سؤاله دون فائدة.
- مثال خاطئ: "نعم متوفر بسعر 250 ريال" بدون ذكر السعر في القائمة → ممنوع.
- مثال صحيح: "السعر مو معاي حالياً، ودّي أتأكد لك من المختص وأرجع لك بأقرب وقت 🌷".`;
    const platformBlock = buildPlatformPromptBlock(this.config, { productsBlock, productContext, avoid });

    // Customer profile injection (additive). Feature flag default ON.
    // Falsy `CUSTOMER_PROFILE_ENABLED=false` disables completely → legacy behavior.
    const profileEnabled = process.env.CUSTOMER_PROFILE_ENABLED !== 'false';
    const profile = profileEnabled ? opts.customerProfile : null;
    let profileBlock = '';
    if (profile && (profile.name || profile.email || profile.last_order_ref || profile.open_question || profile.notes)) {
      profileBlock = `\n\nمعلومات محفوظة عن هذا العميل (استخدمها ولا تطلبها مجدداً إن كانت موجودة):\n`;
      if (profile.name) profileBlock += `- الاسم: ${profile.name}\n`;
      if (profile.email) profileBlock += `- الإيميل: ${profile.email}\n`;
      if (profile.last_order_ref) profileBlock += `- آخر مرجع طلب: ${profile.last_order_ref}\n`;
      if (profile.open_question) profileBlock += `- سؤال معلّق منك للعميل: ${profile.open_question}\n`;
      if (profile.notes) profileBlock += `- ملاحظات: ${profile.notes}\n`;
    }

    const isFirstMsg = opts.isFirstMsg || history.filter(m => m.role === 'assistant').length === 0;
    const welcomeMode = this.config.welcomeMode || 'inline';
    const welcomeHint = (isFirstMsg && welcomeMode === 'inline' && this.config.welcomeMessage?.trim())
      ? `\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي مشابه لـ ⟪${this.config.welcomeMessage}⟫ ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
      : (isFirstMsg && welcomeMode === 'separate')
      ? '\n\n💬 ملاحظة: تم إرسال ترحيب للعميل — اكتب رد يجاوب على طلبه مباشرة.'
      : '';

    // Escalation
    const esc = this.config.escalationContacts;
    let escalationBlock = '';
    if (esc?.length > 0) {
      const contactsList = esc.map((c, i) =>
        `${i + 1}. ${c.name}${c.role ? ' (' + c.role + ')' : ''}${c.phone ? ' — واتساب: ' + c.phone : ''}${c.when ? ' — متى: ' + c.when : ''}${c.messageTemplate ? ' — طريقة رسالة الفريق: ' + c.messageTemplate : ''}`
      ).join('\n');
      escalationBlock = `\n\n📞 التصعيد للجهات المختصة (استثناء، ليس قاعدة):
أنت المتخصص الرسمي لخدمة عملاء هذا المتجر. أجب على كل الأسئلة بنفسك من المعلومات المتاحة لك. لا تعرض التحويل من نفسك.

الحالات الوحيدة لاستخدام التصعيد:
1. العميل طلب صراحة التحدث مع موظف/مختص/إنسان/مسؤول/المالك. كلمات مثل (يبي/يبغى/أبي/ودي/أبغى/أحتاج) + (موظف/مختص/مسؤول/إنسان/بشر/المدير/المالك) → صعّد فوراً بدون محاولة إقناع.
2. الموضوع خارج نطاق المتجر (مثل شكوى رسمية، طلب استرداد كبير، مشكلة دفع معقدة).
3. سؤال لا تجد له إجابة في التعليمات أو المنتجات بعد محاولة جدية للإجابة.

جهات الاتصال المتاحة عند الحاجة:
${contactsList}

عند استخدام التصعيد:
- لا تقل "أحوّلك" أو "خلني أحولك" — هذي عبارات ممنوعة لأنها تشعر العميل بأنك لست متخصصاً.
- استخدم بدلاً منها: "بأخذ بياناتك ويتواصل معك أحد المختصين قريباً" أو "بسجل طلبك ويتم الرد عليك خلال وقت قصير".
- يجب أن تضع علامة التصعيد في نهاية الرد بهذا الشكل: [تحويل:اسم_الجهة|ملخص_موجز_للحالة]
- لا تستخدم العلامة إلا فعلياً عند الحاجة — التصعيد المتكرر يزعج العميل والمالك.

مثال صحيح:
العميل: "أبي أكلم المدير بخصوص طلب رقم 12345"
الرد: "تمام، بسجل طلبك ويتواصل معك المختص خلال وقت قصير. [تحويل:المالك|طلب التواصل بخصوص الطلب 12345]"`;
    }

    // Custom instructions (long) — owner provides the full behavior brief
    if (hasLongCustomInstructions) {
      return `${customInstructions}${knowledgeRules}${platformBlock}${policyBlock}${instantBlock}${profileBlock}${escalationBlock}${welcomeHint}`;
    }

    // Default prompt — structural only. All behavior comes from the dashboard
    // (replyStyle, avoidWords, avoidPhrases, welcomeMessage, escalation contacts).
    return `أنت ${employeeName} في متجر ${this.config.storeName || 'المتجر'}.

📦 المنتجات المتوفرة:
${productsBlock}${productContext ? `\n\n📌 المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}
${platformBlock}${knowledgeRules}${policyBlock}${instantBlock}${profileBlock}${escalationBlock}${welcomeHint}`;
  }

  // ── Get AI Reply ───────────────────────────────────────────────────
  async getReply(history, opts = {}) {
    const { openai, model } = this.buildClient();
    const system = this.buildSystemPrompt(history, opts);
    const messages = [{ role: 'system', content: system }, ...history];

    const lastUserText = opts.latestUserText || [...history].reverse().find(m => m.role === 'user')?.content || '';
    const validatorEnabled = process.env.REPLY_VALIDATOR_ENABLED !== 'false';
    const { matched: matchedPolicies } = validatorEnabled
      ? require('../src/services/ai/knowledge-retrieval').retrieveRelevantPolicies(this.config, lastUserText)
      : { matched: [] };

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      this.logger.info('ai', `📤 AI: "${lastUserMsg.content.substring(0, 60)}" | سجل: ${history.length} | system: ${system.length}`);
    }

    this.lastDebug = {
      timestamp: new Date().toISOString(),
      model, systemPromptLength: system.length,
      systemPromptPreview: system.substring(0, 800),
      messagesCount: messages.length, historyLength: history.length,
      lastUserMessage: lastUserMsg?.content,
      historyPreview: history.slice(-8).map(m => ({ role: m.role, content: m.content.substring(0, 100) })),
    };

    // Rate limiting
    const sinceLastCall = Date.now() - this.lastCallAt;
    if (this.lastCallAt > 0 && sinceLastCall < TIMERS.AI_MIN_CALL_INTERVAL_MS) {
      const wait = TIMERS.AI_MIN_CALL_INTERVAL_MS - sinceLastCall;
      this.logger.info('ai', `⏳ تأخير استباقي ${(wait / 1000).toFixed(1)}ث (حماية من 429)...`);
      await sleep(wait);
    }
    this.lastCallAt = Date.now();

    // Retry on 429 / 5xx / network errors / timeouts
    const maxRetries = opts.maxRetries ?? 3; // up to 4 attempts total
    const maxChars = Math.max(150, parseInt(this.config.maxResponseLength, 10) || 300);
    const maxTokens = Math.min(2000, Math.max(200, Math.ceil(maxChars * 1.8)));

    const baseTemperature = Number.isFinite(opts.temperature)
      ? opts.temperature
      : (Number.isFinite(this.config.temperature) ? this.config.temperature : 0.45);
    const basePresence = Number.isFinite(opts.presencePenalty)
      ? opts.presencePenalty
      : (Number.isFinite(this.config.presencePenalty) ? this.config.presencePenalty : 0.6);
    const baseFrequency = Number.isFinite(opts.frequencyPenalty)
      ? opts.frequencyPenalty
      : (Number.isFinite(this.config.frequencyPenalty) ? this.config.frequencyPenalty : 0.4);

    // Some providers (Gemini via OpenRouter, certain Google endpoints) reject
    // presence/frequency penalties. We strip them after the first 400 that
    // mentions an unsupported parameter — and remember the failure for the
    // remainder of this call.
    let useSamplingPenalties = true;

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const payload = {
          model,
          max_tokens: maxTokens,
          temperature: baseTemperature,
          messages,
        };
        if (useSamplingPenalties) {
          payload.presence_penalty = basePresence;
          payload.frequency_penalty = baseFrequency;
        }

        const res = await openai.chat.completions.create(payload, { timeout: 30000 });
        const rawReply = res.choices[0]?.message?.content || '';
        let reply = stripAvoidedContent(rawReply, this.config);
        if (validatorEnabled) {
          reply = await validateAndRepair({
            reply, config: this.config, customerText: lastUserText, matched: matchedPolicies,
            regenerate: async () => {
              const repairMessages = [
                { role: 'system', content: system + '\n\nأعد صياغة الرد مستخدماً السياسات الجاهزة أعلاه مباشرةً. ممنوع قول "بسأل المختص" لمعلومة موجودة في السياسات.' },
                ...history,
              ];
              const rr = await openai.chat.completions.create(
                { model, max_tokens: maxTokens, temperature: 0.2, messages: repairMessages },
                { timeout: 30000 });
              return stripAvoidedContent(rr.choices[0]?.message?.content || '', this.config);
            },
          });
        }
        // Optional chaining: a caller that forgets the costTracker must never
        // crash the reply (production 2026-06-12: the bridge rephrase died on
        // exactly this line and team answers shipped verbatim).
        if (res.usage) this.costTracker?.record?.(model, res.usage.prompt_tokens || 0, res.usage.completion_tokens || 0);
        if (!reply.trim()) { this.logger.warn('ai', 'الـ AI رد بنص فارغ!'); this.lastDebug.error = 'empty reply'; }
        else { this.logger.info('ai', `📥 رد: ${reply.substring(0, 80)}`); }
        if (rawReply !== reply) {
          this.logger.info('ai', `✂️ post-process: ${rawReply.length} → ${reply.length}`);
        }
        this.lastDebug.reply = reply;
        this.lastDebug.rawReply = rawReply;
        this.lastDebug.success = true;
        return reply;
      } catch (err) {
        lastErr = err;
        const status = err && typeof err.status === 'number' ? err.status : 0;
        const message = String(err?.message || '');
        const code = err?.code || '';

        const mentionsUnsupportedParam =
          /unsupported[_\s-]?param|unsupported parameter|presence_penalty|frequency_penalty/i.test(message);

        // Strip the penalty params and retry immediately for providers that
        // reject them (Gemini etc.). Don't count it as a "real" retry.
        if (useSamplingPenalties && (status === 400 || mentionsUnsupportedParam) && mentionsUnsupportedParam) {
          this.logger.warn('ai', `⚠️ المزود لا يدعم presence_penalty/frequency_penalty — إعادة بدون هذه الحقول`);
          useSamplingPenalties = false;
          // do not increment attempt counter; loop will re-attempt
          attempt--;
          continue;
        }

        const is429 = status === 429
          || /429|rate limit|quota/i.test(message);
        const is5xx = status >= 500 && status < 600;
        const isNetwork =
          ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code) ||
          /timeout|network|socket hang up|fetch failed|connection (reset|refused|aborted)/i.test(message);
        const isRetryable = is429 || is5xx || isNetwork;

        if (isRetryable && attempt < maxRetries) {
          // Exponential backoff with jitter.
          // 429 keeps the longer rate-limit windows.
          let waitMs;
          if (is429) {
            waitMs = attempt === 0 ? 30000 : 60000;
          } else {
            const base = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
            const jitter = Math.floor(Math.random() * 750);
            waitMs = base + jitter;
          }
          const reason = is429 ? '429' : (is5xx ? `5xx (${status})` : `network/${code || 'transient'}`);
          this.logger.warn('ai', `⏳ ${reason} — إعادة بعد ${(waitMs / 1000).toFixed(1)}ث (${attempt + 1}/${maxRetries})`);
          await sleep(waitMs);
          this.lastCallAt = Date.now();
          continue;
        }
        break;
      }
    }
    this.logger.error('ai', `خطأ AI: ${lastErr.message}`);
    this.lastDebug.error = lastErr.message;
    this.lastDebug.success = false;
    throw lastErr;
  }
}

AIClient.resolveEffectiveModel = resolveEffectiveModel;
module.exports = AIClient;
