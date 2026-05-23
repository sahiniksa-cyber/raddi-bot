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
    const model = this.config.model || 'google/gemini-2.0-flash';
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

    const productsBlock = this.config.products?.length
      ? this.config.products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n')
      : hasLongCustomInstructions
      ? 'لم تُدخل منتجات في حقول المنتجات المنفصلة. إذا كانت التعليمات أعلاه تحتوي منتجات أو أسعاراً فهي مصدر الحقيقة؛ لا تخترع أي منتج أو سعر غير مذكور.'
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، قل: "خلني أتأكد لك من التوفر")';
    const knowledgeRules = `\n\nقواعد الدقة وعدم الهبد:
- لا تخترع أي منتج أو مدة أو سعر أو ضمان أو رابط غير مذكور في التعليمات أو قائمة المنتجات
- إذا لم تجد المعلومة في التعليمات، قل للعميل إنك ستتأكد له ثم استخدم التصعيد إذا كان متاحاً
- عند وجود تعارض، التعليمات المكتوبة من المالك وقائمة المنتجات والأسعار هي مصدر الحقيقة`;
    const platformBlock = buildPlatformPromptBlock(this.config, { productsBlock, productContext, avoid });

    const isFirstMsg = opts.isFirstMsg || history.filter(m => m.role === 'assistant').length === 0;
    const welcomeMode = this.config.welcomeMode || 'inline';
    const welcomeHint = (isFirstMsg && welcomeMode === 'inline' && this.config.welcomeMessage?.trim())
      ? `\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي بنفس روح: "${this.config.welcomeMessage}" ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
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
      escalationBlock = `\n\n📞 التحويل والتصعيد:
عندما لا تستطيع حل مشكلة العميل أو يحتاج مساعدة متخصصة، حوّل الطلب لأحد هؤلاء:
${contactsList}

طريقة التحويل: أجب العميل أولاً (مثلاً: "خلني أحوّلك للمختص")، ثم يجب أن تضيف في آخر ردك هذه العلامة الخاصة:
[تحويل:اسم_الشخص|ملخص المشكلة بالتفصيل]
مثال: خلني أحوّلك لأحمد يساعدك بالموضوع [تحويل:أحمد|العميل لديه مشكلة في طلب 5432 لم يصل]
إذا قلت للعميل إنك ستتواصل مع المالك أو المختص ولم تضف العلامة [تحويل:...] فهذا خطأ.
⚠️ لا تستخدم التحويل إلا عند الحاجة الفعلية. العلامة [تحويل:...] لن تظهر للعميل.`;
    }

    // Custom instructions (long)
    if (hasLongCustomInstructions) {
      return `${customInstructions}${knowledgeRules}${platformBlock}${escalationBlock}${welcomeHint}`;
    }

    // Default prompt
    const tone = r.tone || 'ودي ومحترم';
    const dialect = r.useDialect !== false ? (r.dialect || 'السعودية الخفيفة') : 'الفصحى السهلة';
    const emojiMap = { none: 'بدون إيموجي', light: 'إيموجي قليل (نادراً)', medium: 'إيموجي معتدل (1 عند الحاجة)', heavy: 'إيموجي كثير (2-3 لكل رد)' };
    const emojiInstruction = emojiMap[r.emojiLevel || 'medium'];
    const maxLen = Math.max(150, parseInt(this.config.maxResponseLength) || 300);

    return `أنت ${employeeName}، موظف خدمة عملاء بشري في متجر "${this.config.storeName || 'المتجر'}".
أنت إنسان حقيقي. لو سُئلت "هل أنت بوت؟" قل: "لا، أنا ${employeeName} من فريق ${this.config.storeName || 'المتجر'}".

🎯 مهمتك: اقرأ آخر رسالة من العميل وأجب عليها بدقة.

🏪 معلومات المتجر:
- الاسم: ${this.config.storeName || 'متجري'}
- الوصف: ${this.config.storeDescription || '—'}
- ساعات العمل: ${this.config.workingHours || '—'}

📦 المنتجات المتوفرة:
${productsBlock}
${productContext ? `\n📌 المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}

✏️ أسلوب الرد:
- نبرة: ${tone}
- لغة: ${dialect}
- إيموجي: ${emojiInstruction}
- ${r.useShortReplies ? 'ردود قصيرة (جملة-جملتين)' : `أقصى ${maxLen} حرف`}
- اكتب عفوي بشري: "ثانية بس"، "خلني أشوف"، "والله"
${platformBlock}

✏️ تنسيق الرد (مهم):
- نظّم المعلومات بأسطر منفصلة وترتيب واضح
- استخدم النقاط (- أو •) عند ذكر قائمة أسعار أو خيارات
- تجنب رموز Markdown الكتابية (** ## --- |جداول|)

🚫 ممنوع:
- قول هذه الكلمات أبداً: ${avoid}
- تكرار الترحيب إذا كنت رحبت في رسالة سابقة

⚡ مهم: ركّز على آخر رسالة من العميل وأجب عليها.${knowledgeRules}${escalationBlock}${welcomeHint}`;
  }

  // ── Get AI Reply ───────────────────────────────────────────────────
  async getReply(history, opts = {}) {
    const { openai, model } = this.buildClient();
    const system = this.buildSystemPrompt(history, opts);
    const messages = [{ role: 'system', content: system }, ...history];

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

    // Retry on 429
    const maxRetries = opts.maxRetries ?? 2;
    const maxChars = Math.max(150, parseInt(this.config.maxResponseLength, 10) || 300);
    const maxTokens = Math.min(2000, Math.max(200, Math.ceil(maxChars * 1.8)));
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await openai.chat.completions.create({ model, max_tokens: maxTokens, temperature: 0.3, messages }, { timeout: 30000 });
        const reply = res.choices[0]?.message?.content || '';
        if (res.usage) this.costTracker.record(model, res.usage.prompt_tokens || 0, res.usage.completion_tokens || 0);
        if (!reply.trim()) { this.logger.warn('ai', 'الـ AI رد بنص فارغ!'); this.lastDebug.error = 'empty reply'; }
        else { this.logger.info('ai', `📥 رد: "${reply.substring(0, 80)}"`); }
        this.lastDebug.reply = reply;
        this.lastDebug.success = true;
        return reply;
      } catch (err) {
        lastErr = err;
        const is429 = err.status === 429 || String(err.message).includes('429') || String(err.message).includes('rate limit') || String(err.message).includes('quota');
        if (is429 && attempt < maxRetries) {
          const waitMs = attempt === 0 ? 30000 : 60000;
          this.logger.warn('ai', `⏳ حد الطلبات (429) — إعادة بعد ${waitMs / 1000}ث (${attempt + 1}/${maxRetries})...`);
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

module.exports = AIClient;
