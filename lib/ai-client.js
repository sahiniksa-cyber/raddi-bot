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
const { stripAvoidedContent, applyLineBreakFormat } = require('./post-process-reply');
const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');
const { buildConversationStateBlock } = require('../src/services/ai/conversation-state');
const { buildSlaBlock } = require('../src/services/instruction-routing/sla-block');
const { buildProhibitionsBlock, buildTenantPoliciesBlock } = require('../src/services/instruction-routing/policy-blocks');
const { validateAndRepair } = require('../src/services/ai/reply-validator');
const {
  applyGroundingFallback,
  buildReviewUnavailableReply,
  cleanupFinalReplyDeterministically,
  deterministicDuplicateGuard,
  normalizeEmojiSuitability,
  reviewFinalReplyBeforeSend,
  reviewReplyQuality,
} = require('../src/services/ai/reply-quality-gate');

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

  /**
   * Reviews the actual final WhatsApp text at the send boundary. Unlike
   * getReply(), this method sees instant/canned content after composition and
   * the already-sent assistant turns, so it can suppress semantic duplicates.
   * Errors intentionally propagate: an unreviewed reply must never be sent.
   */
  async reviewBeforeSend({ draft, history = [], customerText = '', source = 'ai_reply' } = {}) {
    const { openai, model } = this.buildClient();
    const retrieval = retrieveRelevantPolicies(this.config, customerText);
    const reviewed = await reviewFinalReplyBeforeSend({
      openai,
      model,
      draft,
      customerText,
      history,
      config: this.config,
      matchedPolicies: retrieval.matched,
      source,
      logger: this.logger,
      maxTokens: this.config.maxTokens || 900,
      onUsage: async (inputTokens, outputTokens) => {
        try {
          await this.costTracker?.record?.(model, inputTokens, outputTokens);
        } catch (err) {
          this.logger?.warn?.('pre-send-review', `usage tracking failed: ${err.message}`);
        }
      },
    });
    if (reviewed.suppressed) return reviewed;

    let reply = cleanupFinalReplyDeterministically(reviewed.reply);
    reply = stripAvoidedContent(reply, this.config);
    reply = await validateAndRepair({
      reply,
      config: this.config,
      customerText,
      matched: retrieval.matched,
    });
    const grounded = applyGroundingFallback({
      reply,
      config: this.config,
      matchedPolicies: retrieval.matched,
      customerText,
    });
    reply = applyLineBreakFormat(grounded.reply, this.config);
    reply = normalizeEmojiSuitability(reply, this.config, customerText);
    reply = cleanupFinalReplyDeterministically(reply);
    if (!reply) throw new Error('pre-send review produced an empty final reply');

    // Merchant sanitizers and the deterministic validator run after the AI
    // review. They can remove the only new clause and accidentally turn a
    // previously acceptable draft into a pure repeat. Re-check the actual
    // final bytes returned to the outgoing worker, not an earlier version.
    const finalDuplicate = deterministicDuplicateGuard(reply, history);
    if (finalDuplicate.suppress) {
      return {
        reply: '',
        suppressed: true,
        audit: {
          ...reviewed.audit,
          decision: 'suppress',
          reason: 'final_post_process_duplicate_without_new_customer_turn',
          repeatedClaims: finalDuplicate.repeatedClaims,
          violations: [...(reviewed.audit?.violations || []), 'semantic_duplicate_after_post_process'],
        },
      };
    }

    return {
      ...reviewed,
      reply,
      audit: {
        ...reviewed.audit,
        unsupportedClaims: grounded.issues.map(issue => issue.value),
        hardFallback: grounded.usedFallback || reviewed.audit?.hardFallback === true,
      },
    };
  }

  // ── System Prompt Builder ──────────────────────────────────────────
  // Thin passthrough for auxiliary STRUCTURED calls (e.g. conversation-state
  // extraction). Reuses the tenant's configured provider/model from buildClient();
  // CONVERSATION_STATE_MODEL may override the model string.
  async raw({ messages, temperature = 0.2, max_tokens = 600, response_format } = {}) {
    const { openai, model } = this.buildClient();
    const effModel = (process.env.CONVERSATION_STATE_MODEL || '').trim() || model;
    const payload = { model: effModel, messages, temperature, max_tokens };
    if (response_format) payload.response_format = response_format;
    return openai.chat.completions.create(payload, { timeout: 15000 });
  }

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
    const knowledgeRulesLegacy = `\n\nقواعد الدقة وعدم الهبد (إلزامية — اتباعها أهم من سرعة الرد):
- افهم نية العميل من رسالته كاملة أولاً وجاوب على كل أسئلته في ردّ واحد متماسك بدون أن تترك أي سؤال. القاعدة الوحيدة: لا تجمع لنفس الطلب بين طلب معلومة من العميل ووعدٍ بالتحويل/التصعيد (متناقضان). إن كانت نية العميل غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
- إذا بدأت رسالة العميل بتحية (مثل السلام عليكم، هلا، مرحبا) ثم سؤال أو أكثر، فرد على التحية بكلمة واحدة قصيرة ثم جاوب على كل الأسئلة في نفس الرسالة فوراً — لا تكتفِ بردّ التحية وتتجاهل الأسئلة إطلاقاً.
- إذا حوت رسالة العميل أكثر من سؤال أو طلب، جاوب على جميع الأسئلة في ردّك ولا تترك أي سؤال بدون إجابة.
- لا تعِد العميل بالتحويل أو إرسال طلبه للمختص إلا إذا كنت ستصعّد فعلاً ولا تطلب منه معلومة في نفس الرسالة. وإذا منع المالك عبارة معيّنة فلا تستخدمها ولا أي صياغة قريبة منها إطلاقاً.
- ممنوع تماماً اختراع أي منتج أو مدة أو سعر أو ضمان أو رابط أو ميزة غير مذكورة في التعليمات أو قائمة المنتجات أعلاه. لا تخمّن، لا تستنتج من أسماء المنتجات، لا تستخدم معلومة عامة من خارج المتجر.
- إذا سأل العميل عن شيء غير موجود لديك، استخدم البديل الآمن: "ودّي أأكد لك المعلومة من المختص قبل ما أعطيك جواب مؤكد، تسمح لي؟" — ثم استخدم تصعيداً إذا كان متاحاً، أو اطلب من العميل التواصل المباشر.
- لا تقل "بسأل المسؤول" ثم تخترع جواباً. إما تنتظر تأكيد التصعيد، أو ترد بما عندك فقط.
- إذا لم تفهم طلب العميل أو لم تكن متأكداً من المقصود، لا تخمّن ولا ترمِ رداً عاماً: اطلب توضيحاً قصيراً محدداً، أو صعّد للمختص إذا كان الموضوع خارج معلوماتك. الرد الخاطئ بثقة أسوأ من سؤال توضيحي.
- عند تعارض المعلومات: التعليمات المكتوبة من المالك > قائمة المنتجات والأسعار > أي شيء آخر.
- ممنوع أي عبارة عرض خدمة عامة أو آلية (مثل "كيف أقدر أساعدك/أخدمك"، "كيف يمكنني مساعدتك"). بدلاً منها اسأل سؤالاً ملموساً عن طلب العميل أو ادخل في صلب الموضوع مباشرة.
- تصرّف كموظف بشري حقيقي يكتب على واتساب، لا كروبوت، ولا تذكر أبداً أي منهجية أو أسماء أطر أو وسوم تقنية أو حد عدد أحرف.
- إذا شكّ العميل أنك بوت أو ذكاء اصطناعي أو "شات جي بي تي"، أو سألك إن كنت إنساناً: لا تنكر، ولا تجادل، ولا تؤكد أنك إنسان، ولا تعترف بأنك آلي. تجاوز الأمر بهدوء بجملة قصيرة واحدة (مثل: «أنا من خدمة عملاء ${this.config.storeName || 'المتجر'} وموجود أساعدك») ثم أكمل مساعدته في طلبه مباشرة. لا تكرر إثبات نفسك ولا تدخل في نقاش حول هويتك إطلاقاً.
- ممنوع إنهاء الرد بسؤال حشو متكرر مثل «تبي شي ثاني؟» أو «تأمر بشي ثاني؟» أو «أي شي ثاني؟ أنا هنا» أو «في خدمتك» إلا إذا كان هناك خطوة بيع/طلب مفتوحة فعلاً (اختيار خيار أو دفع أو تأكيد طلب). إذا أُجيب سؤال العميل بالكامل ولا يوجد قرار معلّق، اكتفِ بالجواب بدون أي سؤال إضافي. ولا تكرر نفس عبارة الإغلاق في ردّين متتاليين.
- إذا أبدى العميل ما يدل على الرضا أو إنهاء المحادثة (مثل: تمام، خلاص، شكراً، يعطيك العافية، تم، كفو، الله يعافيك)، فاعتبر طلبه مُنجزاً: اختم بعبارة شكر قصيرة واحدة متنوّعة بدون أي سؤال متابعة، ولا تفتح موضوعاً جديداً.
- لا تكرر نفس الجملة أو المعلومة داخل الرد الواحد. والأهم: لا تُعِد أي معلومة أو فكرة أو طمأنة سبق أن قلتها للعميل في هذه المحادثة — لا بنفس الكلمات ولا بصياغة مختلفة — إلا إذا طلب العميل تكرارها أو سأل عنها مباشرةً. تغيير الصياغة لا يجعل الإعادة مقبولة؛ إعادة نفس المضمون بكلمات أخرى تكرار ممنوع.
- إذا كان العميل قد أخذ المعلومة من قبل ولا جديد لديك تضيفه، لا تُعِد شرحها إطلاقاً: جاوب فقط على ما هو جديد فعلاً، وإن لم يوجد جديد فاكتفِ برد قصير مناسب (تأكيد قصير أو شكر) بدون أي إعادة أو إعادة فتح للموضوع.
- افهم سؤال العميل فعلاً وقدّم له المعلومة أو الحل الدقيق؛ لا تكتفِ بعبارات مجاملة أو بإعادة صياغة سؤاله دون فائدة.
- إذا لم تفهم قصد العميل بوضوح، لا ترد بكلام عام أو حشو لا يعالج طلبه؛ اسأله سؤالاً توضيحياً واحداً محدداً يوضّح ما يريد، أو صعّد إن كان يطلب مختصاً. ممنوع تخمين الجواب أو الرد بما لا يخص سؤاله.
- مثال خاطئ: "نعم متوفر بسعر 250 ريال" بدون ذكر السعر في القائمة → ممنوع.
- مثال صحيح: "السعر مو معاي حالياً، ودّي أتأكد لك من المختص وأرجع لك بأقرب وقت 🌷".`;

    // SAFETY CORE — behaviors that MUST survive; NO imposed style/phrasings.
    // Every line here is a guard, not a voice. The merchant's voice comes from
    // botInstructions + replyStyle (dialect/tone/length) in the dashboard —
    // this block must never override those. Selected by PROMPT_STYLE_SPLIT_ENABLED.
    const safetyCore = `\n\nقواعد أساسية إلزامية:
- افهم رسالة العميل كاملة وجاوب على كل أسئلته في ردّ واحد وبأقصر عبارة ممكنة، بدون ترك أي سؤال وبدون شرح زائد أو حشو. إن كانت النية غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
- ممنوع تماماً اختراع أي منتج أو مدة أو سعر أو ضمان أو رابط أو ميزة غير مذكورة في التعليمات أو قائمة المنتجات. لا تخمّن ولا تستنتج من الأسماء ولا تستخدم معلومة من خارج المتجر.
- كل منتج له خياراته ومدده وأسعاره الخاصة به وحده: ممنوع منعاً باتاً تنسب مدة أو سعر أو خيار من منتج إلى منتج آخر، وممنوع تفترض وجود مدة أطول أو أقصر غير المدرجة صراحةً تحت المنتج نفسه. لما يسأل العميل عن منتج معيّن، اذكر فقط الخيارات المكتوبة تحت ذلك المنتج بالذات — لو مدرج له خيار واحد فقط، فهو الوحيد المتاح.
- لا تقل إنك ستسأل المختص ثم تخترع جواباً. إمّا تنتظر تأكيد التصعيد أو ترد بما عندك فقط. ولا تطلب معلومة من العميل ووعدٍ بالتحويل في نفس الرسالة (متناقضان).
- عند تعارض المعلومات: تعليمات المالك > قائمة المنتجات والأسعار > أي شيء آخر.
- إذا شكّ العميل أنك بوت أو ذكاء اصطناعي أو سألك إن كنت إنساناً: لا تنكر ولا تجادل ولا تؤكد أنك إنسان ولا تعترف بأنك آلي. تجاوز الأمر بجملة قصيرة واحدة (مثل: «أنا من خدمة عملاء ${this.config.storeName || 'المتجر'} وموجود أساعدك») ثم أكمل مساعدته. لا تدخل في نقاش حول هويتك.
- لا تُعِد أي معلومة أو طمأنة سبق أن قلتها في هذه المحادثة — لا بنفس الكلمات ولا بصياغة مختلفة — إلا إذا طلب العميل ذلك. تغيير الصياغة لا يجعل الإعادة مقبولة.
- إذا لم تفهم قصد العميل، اطلب توضيحاً واحداً محدداً أو صعّد إن كان يطلب مختصاً. الرد الخاطئ بثقة أسوأ من سؤال توضيحي.
- لا تُنهِ الرد بسؤال حشو (مثل «تبي شي ثاني؟») إلا عند خطوة بيع/طلب مفتوحة فعلاً. إذا أُجيب السؤال ولا قرار معلّق، اكتفِ بالجواب.`;

    const knowledgeRules = process.env.PROMPT_STYLE_SPLIT_ENABLED === 'true'
      ? safetyCore
      : knowledgeRulesLegacy;
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

    // Escalation state: the team was already notified of this customer's request
    // and hasn't answered yet. Without this the bot has NO idea it already
    // escalated, so it re-promises "بسجل طلبك / بيتواصل معك الفريق" on every
    // follow-up (the production loop the owner flagged). Tell it the request is
    // on record and to stop re-registering it.
    const pendingEscalationBlock = opts.escalationPending
      ? `\n\n🔔 حالة هذه المحادثة: سبق وتم تصعيد طلب هذا العميل للفريق المختص، وطلبه الآن مُسجّل وقيد المتابعة.
- لا تسجّل الطلب من جديد، ولا تكرر وعوداً مثل «بسجل طلبك» أو «بيتواصل معك الفريق» أو «بأرفع المشكلة للدعم» أو «بأخذ معلوماتك».
- إذا سأل العميل عن حالة طلبه أو تابع الموضوع، طمئنه بجملة واحدة قصيرة فقط بأن طلبه مُسجّل وقيد المتابعة، بدون إعادة شرح ولا فتح الموضوع من جديد ولا فتح أي موضوع آخر (تقسيط/اشتراك...).
- لا تُصدر علامة تحويل [تحويل:...] جديدة لنفس الموضوع. لا تستخدمها إلا إذا طلب العميل صراحةً التحدث مع مسؤول الآن، أو أبلغ عن مشكلة جديدة مختلفة تماماً.`
      : '';

    // Generic conversation-state block (#176, flagged, fail-soft): injected only
    // when the flag is on AND the caller confirms the stored state is current.
    const conversationStateBlock = (process.env.CONVERSATION_STATE_ENABLED === 'true')
      ? buildConversationStateBlock(opts.conversationState, { canInject: opts.conversationStateCanInject === true })
      : '';
    // Instruction Routing (#177, flagged): SLA + prohibitions + tenant policies
    // rendered as authoritative facts. Empty when off/none.
    const routingEnabled = process.env.INSTRUCTION_ROUTING_ENABLED === 'true';
    const slaBlock = routingEnabled ? buildSlaBlock(this.config.slaPolicies) : '';
    const routedPoliciesBlock = routingEnabled
      ? `${buildProhibitionsBlock(this.config.prohibitions)}${buildTenantPoliciesBlock(this.config.tenantPolicies)}`
      : '';

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

    // Bounded persona (#177, flagged): a long botInstructions must NOT become the
    // whole prompt base and dominate platform logic. When enabled, inject it as a
    // capped, subordinate persona section inside the structured prompt.
    if (process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED === 'true' && hasLongCustomInstructions) {
      const personaMax = parseInt(process.env.BOT_INSTRUCTIONS_MAX_CHARS || '1500', 10);
      const persona = customInstructions.length > personaMax
        ? `${customInstructions.slice(0, personaMax)}…`
        : customInstructions;
      const personaBlock = `\n\n<شخصية_وأسلوب_الموظف>\n(نبرة وأسلوب فقط. قواعد المنصة والمنتجات والتصعيد وحالة المحادثة أدناه هي المصدر الأعلى وتعلو على أي تعليمة هنا عند التعارض.)\n${persona}\n</شخصية_وأسلوب_الموظف>`;
      return `أنت ${employeeName} في متجر ${this.config.storeName || 'المتجر'}.${personaBlock}

📦 المنتجات المتوفرة:
${productsBlock}${productContext ? `\n\n📌 المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}
${platformBlock}${knowledgeRules}${policyBlock}${instantBlock}${profileBlock}${pendingEscalationBlock}${conversationStateBlock}${slaBlock}${routedPoliciesBlock}${escalationBlock}${welcomeHint}`;
    }

    // Custom instructions (long) — owner provides the full behavior brief
    if (hasLongCustomInstructions) {
      return `${customInstructions}${knowledgeRules}${platformBlock}${policyBlock}${instantBlock}${profileBlock}${pendingEscalationBlock}${conversationStateBlock}${slaBlock}${routedPoliciesBlock}${escalationBlock}${welcomeHint}`;
    }

    // Default prompt — structural only. All behavior comes from the dashboard
    // (replyStyle, avoidWords, avoidPhrases, welcomeMessage, escalation contacts).
    return `أنت ${employeeName} في متجر ${this.config.storeName || 'المتجر'}.

📦 المنتجات المتوفرة:
${productsBlock}${productContext ? `\n\n📌 المنتجات المطابقة لسؤال العميل:\n${productContext}` : ''}
${platformBlock}${knowledgeRules}${policyBlock}${instantBlock}${profileBlock}${pendingEscalationBlock}${conversationStateBlock}${slaBlock}${routedPoliciesBlock}${escalationBlock}${welcomeHint}`;
  }

  // Sampling resolution — presence/frequency penalties push the model toward
  // novel wording (off-voice: "خبرني" etc. the owner never wrote). Flag-gated
  // (AI_SAMPLING_PENALTIES_ENABLED=false) so staging can disable them without a
  // code change. AI_DRAFT_TEMPERATURE lets the draft run cooler for consistency.
  resolveSampling(opts = {}) {
    const penaltiesEnabled = process.env.AI_SAMPLING_PENALTIES_ENABLED !== 'false';
    const envTemp = parseFloat(process.env.AI_DRAFT_TEMPERATURE);
    const temperature = Number.isFinite(opts.temperature)
      ? opts.temperature
      : Number.isFinite(this.config.temperature) ? this.config.temperature
      : Number.isFinite(envTemp) ? envTemp
      : 0.45;
    const presence = Number.isFinite(opts.presencePenalty) ? opts.presencePenalty
      : Number.isFinite(this.config.presencePenalty) ? this.config.presencePenalty : 0.6;
    const frequency = Number.isFinite(opts.frequencyPenalty) ? opts.frequencyPenalty
      : Number.isFinite(this.config.frequencyPenalty) ? this.config.frequencyPenalty : 0.4;
    return { temperature, presence, frequency, usePenalties: penaltiesEnabled };
  }

  // ── Get AI Reply ───────────────────────────────────────────────────
  async getReply(history, opts = {}) {
    const { openai, model } = this.buildClient();
    const system = this.buildSystemPrompt(history, opts);
    const messages = [{ role: 'system', content: system }, ...history];

    const lastUserText = opts.latestUserText || [...history].reverse().find(m => m.role === 'user')?.content || '';
    const validatorEnabled = process.env.REPLY_VALIDATOR_ENABLED !== 'false';
    const qualityGateEnabled = opts.qualityGate !== false && process.env.REPLY_QUALITY_GATE_ENABLED !== 'false';
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
    // Floor of 800 tokens so a formatted product card + full URL is NEVER cut
    // mid-content (production 2026-07-02: a small maxResponseLength=200 → 360-token
    // cap truncated a reply at "https://prostoree."). maxResponseLength stays a
    // SOFT brevity guide in the prompt; this ceiling only prevents hard truncation.
    const maxTokens = Math.min(2000, Math.max(800, Math.ceil(maxChars * 1.8)));

    const { temperature: baseTemperature, presence: basePresence,
            frequency: baseFrequency, usePenalties } = this.resolveSampling(opts);

    // Some providers (Gemini via OpenRouter, certain Google endpoints) reject
    // presence/frequency penalties. We strip them after the first 400 that
    // mentions an unsupported parameter — and remember the failure for the
    // remainder of this call. usePenalties also disables them by config/flag.
    let useSamplingPenalties = usePenalties;

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

        // Independent semantic review before anything can be persisted or
        // enqueued. The reviewer reconstructs the customer's intent, checks
        // every answer against merchant-owned sources, and repairs the draft
        // once. A reviewer outage never silences the bot: the deterministic
        // price/duration/URL guard still removes hard unsupported facts.
        let qualityGateAudit;
        if (qualityGateEnabled) {
          try {
            const reviewed = await reviewReplyQuality({
              openai,
              model,
              draft: reply,
              customerText: lastUserText,
              history,
              config: this.config,
              matchedPolicies,
              logger: this.logger,
              maxTokens,
              onUsage: async (inputTokens, outputTokens) => {
                try {
                  await this.costTracker?.record?.(model, inputTokens, outputTokens);
                } catch (usageErr) {
                  // Accounting is best-effort and must never invalidate an
                  // otherwise successful customer-safety review.
                  this.logger.warn('quality-gate', `usage tracking failed: ${usageErr.message}`);
                }
              },
            });
            reply = reviewed.reply;
            qualityGateAudit = reviewed.audit;
          } catch (qualityErr) {
            const grounded = applyGroundingFallback({
              reply,
              config: this.config,
              matchedPolicies,
              customerText: lastUserText,
            });
            // Correctness wins over availability: if the semantic reviewer is
            // down, never ship an unreviewed factual answer. Hard numeric/URL
            // inventions use the normal grounded escalation; other drafts get
            // a truthful retry-later response instead of a guess.
            reply = grounded.usedFallback ? grounded.reply : buildReviewUnavailableReply();
            qualityGateAudit = {
              status: 'fallback',
              decision: 'review_error',
              intent: '',
              unanswered: [],
              violations: ['review_error'],
              unsupportedClaims: grounded.issues.map(issue => issue.value),
              hardFallback: true,
              latencyMs: 0,
              error: String(qualityErr?.message || qualityErr).slice(0, 240),
            };
            this.logger.warn('quality-gate', `review failed; deterministic fallback applied: ${qualityErr.message}`);
          }
        } else {
          const grounded = applyGroundingFallback({
            reply,
            config: this.config,
            matchedPolicies,
            customerText: lastUserText,
          });
          reply = grounded.reply;
          qualityGateAudit = {
            status: 'disabled',
            decision: 'not_reviewed',
            intent: '',
            unanswered: [],
            violations: [],
            unsupportedClaims: grounded.issues.map(issue => issue.value),
            hardFallback: grounded.usedFallback,
            latencyMs: 0,
          };
        }

        // The reviewer's final reply is untrusted model output too. Re-run the
        // deterministic sanitizer and style/escalation rules with NO further
        // regeneration, so the quality gate is the final AI call in the path.
        reply = stripAvoidedContent(reply, this.config);
        if (validatorEnabled) {
          reply = await validateAndRepair({
            reply,
            config: this.config,
            customerText: lastUserText,
            matched: matchedPolicies,
          });
        }
        // Enforce the merchant's line-break mode (sentence/words/topic). Runs on
        // the FINAL text (after the validator), and protects URLs and the
        // escalation marker from being split. The ai/topic modes also have a
        // deterministic fallback when a model returns one long block.
        reply = applyLineBreakFormat(reply, this.config);
        reply = normalizeEmojiSuitability(reply, this.config, lastUserText);
        this.lastDebug.qualityGate = qualityGateAudit;
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

  /**
   * Smart-merge a merchant's free-text edit request into the current bot
   * instructions. Returns { newInstructions, summary } — the full updated
   * instructions and a one-line Arabic summary of what changed. Throws a clear
   * Arabic error when the model reply can't be parsed as JSON.
   */
  // Classifies a merchant's free-form reply to a pending-edit confirmation as
  // 'confirm' | 'cancel' | 'other', so ANY natural wording works (not a fixed
  // keyword list). Fail-safe: returns 'other' on any error so an unclear/failed
  // reply never auto-applies or auto-cancels.
  async classifyReplyIntent(text) {
    const clean = String(text || '').trim();
    if (!clean) return 'other';
    let openai, model;
    try { ({ openai, model } = this.buildClient()); } catch (_) { return 'other'; }
    const system = [
      'سياق: تاجر لديه تعديل معلّق على إعدادات بوت، وسُئل "هل تؤكّد التطبيق؟ (نعم/لا)".',
      'صنّف رده إلى كلمة إنجليزية واحدة فقط:',
      '- confirm: إذا كان يوافق/يؤكّد/يطلب التطبيق (مثل: نعم، تم، أكّد، ثبّتها، يالله سوّها).',
      '- cancel: إذا كان يرفض/يلغي/يتراجع (مثل: لا، ألغِ، خلها زي ما هي، لا تغيّر).',
      '- other: إذا كان غير واضح أو كلام غير متعلق بالتأكيد.',
      'أجب بكلمة واحدة فقط: confirm أو cancel أو other.',
    ].join('\n');
    try {
      const res = await openai.chat.completions.create({
        model, max_tokens: 5, temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: clean }],
      }, { timeout: 15000 });
      const out = String(res.choices?.[0]?.message?.content || '').toLowerCase();
      if (out.includes('confirm')) return 'confirm';
      if (out.includes('cancel')) return 'cancel';
      return 'other';
    } catch (_) {
      return 'other';
    }
  }

  // Reviews customer messages for campaign segmentation. This is deliberately
  // advisory: the caller validates product names and order evidence again
  // before anything is persisted. A claimed order without a concrete order
  // reference must never be promoted to an order-confirmed segment.
  async classifyCampaignCustomer({ messages = [], products = [] } = {}) {
    const catalog = (Array.isArray(products) ? products : [])
      .map(product => String(product?.name || product || '').trim())
      .filter(Boolean)
      .slice(0, 100);
    const transcript = (Array.isArray(messages) ? messages : [])
      .filter(message => message?.direction === 'inbound' || message?.role === 'user')
      .map(message => String(message?.content || message?.body || '').trim())
      .filter(Boolean)
      .slice(-40);
    if (!catalog.length || !transcript.length) return [];

    let openai, model;
    try { ({ openai, model } = this.buildClient()); } catch (_) { return []; }
    const system = [
      'You classify customer messages for a merchant campaign audience.',
      'Return JSON only in this exact shape:',
      '{"signals":[{"productName":"","state":"interested_unverified|ordered_confirmed|needs_verification","confidence":0.0,"evidenceText":"","orderReference":null}]}',
      'Use productName only from the supplied catalog. Do not invent products or facts.',
      'ordered_confirmed is allowed only when the customer message contains a concrete order number/reference.',
      'A statement such as "I ordered" or "I paid" without a concrete reference is needs_verification.',
      'A product question or interest without verified purchase evidence is interested_unverified.',
      'evidenceText must be a short verbatim excerpt from the supplied customer messages.',
      'If there is no product signal, return {"signals":[]}.',
    ].join('\n');
    const user = JSON.stringify({ products: catalog, customerMessages: transcript });
    try {
      const res = await openai.chat.completions.create({
        model,
        max_tokens: 700,
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }, { timeout: 20000 });
      if (res.usage) {
        await this.costTracker?.record?.(
          model,
          res.usage.prompt_tokens || 0,
          res.usage.completion_tokens || 0,
        );
      }
      const parsed = this._parsePromptEditJson(res.choices?.[0]?.message?.content || '');
      return Array.isArray(parsed?.signals) ? parsed.signals : [];
    } catch (_) {
      return [];
    }
  }

  // Classifies a natural edit command into a structured operation for a config
  // section. Returns the parsed plan object, or null when the target is not one
  // of the known sections or the reply can't be parsed (caller then falls back
  // to the prompt path — today's behavior). Payloads are SMALL values, so JSON
  // here is safe (unlike the full instructions, which use proposePromptEdit).
  async planConfigEdit(config, request) {
    let openai, model;
    try { ({ openai, model } = this.buildClient()); } catch (_) { return null; }
    // Full product context (name + price + variants) so the model can understand
    // nuanced edits like "remove the yearly option, keep 4 & 8 months" and
    // recompute the WHOLE new variants list — not just match a name.
    const productsCtx = (Array.isArray(config?.products) ? config.products : []).map((p) => ({
      name: String(p && p.name || '').trim(),
      price: p && p.price || '',
      variants: Array.isArray(p && p.variants)
        ? p.variants.map((v) => ({ label: v && v.label || '', price: v && v.price || '' })) : [],
    })).filter((p) => p.name);
    const replyKeys = config?.autoReplyKeywords && typeof config.autoReplyKeywords === 'object'
      ? Object.keys(config.autoReplyKeywords) : [];
    const system = [
      'أنت مساعد يفهم أمر التاجر الطبيعي ويحوّله إلى عملية على إعدادات متجره. أعد JSON فقط.',
      'افهم قصد التاجر بأي صياغة — لا تشترط كلمات معيّنة.',
      'الأقسام (target): "products" أو "instant_replies" أو "do_not_reply" أو "prompt".',
      'الافتراضي "prompt": أي توجيه لسلوك البوت أو كيف يرد ("لو العميل يبي كذا قوله كذا"، "إذا سأل عن كذا اشرح له") = prompt.',
      'استخدم "instant_replies" فقط لو طلب التاجر صراحةً رداً فورياً/تلقائياً جاهزاً (ذكر "رد فوري" أو "رد تلقائي" أو "لمّا يكتب كلمة كذا أرسل هذا النص حرفياً"). غير ذلك = prompt.',
      'العملية (action): "add" أو "update" أو "delete".',
      'الشكل:',
      '{"target":"...","action":"...","summary":"<عربي سطر واحد يصف التغيير بدقة>","clarify":"<اتركه فارغاً إلا عند غموض حقيقي>",',
      ' "product":{"name":"","price":"","description":"","url":"","longDescription":"","variants":[{"label":"","price":""}]},',
      ' "keyword":"","reply":"","number":"","name":""}',
      'مهم لِـ products:',
      '- حدّد المنتج بنفسك من القائمة أدناه واستخدم اسمه المطابق بالضبط في product.name. لا تسأل "هل تقصد؟" إذا قدرت تحدّده.',
      '- عدّل المتغيّرات: عند طلب حذف/إبقاء خيارات (مثل "احذف السنة، خلّ 4 و8 أشهر") استخدم action=update وأرجِع في variants **القائمة الكاملة الجديدة** بعد التعديل (احتفظ بأسعار الخيارات الباقية كما هي).',
      '- استخدم "clarify" فقط لو تعذّر تحديد المنتج نهائياً أو تطابق أكثر من منتج بنفس القوة.',
      'ضع الحقول ذات الصلة فقط. لا تخترع أسعاراً أو بيانات لم يذكرها التاجر.',
      `المنتجات الحالية (JSON): ${JSON.stringify(productsCtx) || '[]'}`,
      `كلمات الردود الفورية الحالية: ${replyKeys.join(' | ') || '(لا يوجد)'}`,
    ].join('\n');
    let raw;
    try {
      const res = await openai.chat.completions.create({
        model, max_tokens: 700, temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: String(request || '') }],
      }, { timeout: 20000 });
      raw = res.choices?.[0]?.message?.content || '';
    } catch (_) { return null; }

    const plan = this._parsePromptEditJson(raw);
    const targets = ['products', 'instant_replies', 'do_not_reply', 'prompt'];
    if (!plan || !targets.includes(plan.target)) return null;
    return plan;
  }

  async proposePromptEdit(currentInstructions, editRequest) {
    const { openai, model } = this.buildClient();
    // Delimiter protocol (NOT JSON): embedding the full multi-line instructions
    // inside a JSON string value made the model emit literal newlines → invalid
    // JSON → parse failed every time (production 2026-07-01). A plain-text
    // sentinel tolerates any newlines/quotes/Arabic without escaping.
    const system = [
      'أنت محرر تعليمات بوت خدمة عملاء. مهمتك: تطبيق تعديل التاجر على التعليمات الحالية.',
      'افهم قصد التاجر (إضافة معلومة جديدة، أو تعديل سطر موجود، أو حذف شيء)،',
      'ثم أعد التعليمات الكاملة بعد التعديل مع الحفاظ على كل ما لم يُطلب تغييره كما هو.',
      // Conflict-aware merge: the merchant often adds new info without saying
      // "remove the old contradicting line" — leaving both created wrong answers
      // to customers. Actively reconcile contradictions instead of just appending.
      'مهم جداً: إذا كان التعديل الجديد يعارض أو يكرّر معلومة موجودة عن نفس الموضوع (مثال: سعر/مدة/سياسة توصيل مختلفة)، احذف أو استبدل السطر القديم المتعارض بدل ما تخلّي الاثنين — لأن بقاء معلومتين متناقضتين يربك العميل.',
      'لا تحذف شيئاً غير متعلّق بالتعديل. احذف فقط ما يعارض/يكرّر الجديد.',
      'لا تخترع معلومات لم يذكرها التاجر. رتّب التعليمات بشكل واضح.',
      '',
      'أعد ردك بهذا الشكل بالضبط (بدون أي نص إضافي، وبدون علامات تنسيق):',
      'السطر الأول: ملخص سطر واحد بالعربي لما تغيّر — واذكر صراحةً إذا شلت/استبدلت سطراً قديماً متعارضاً (مثال: "أضفت سعر التوصيل الجديد وشلت سطر التوصيل المجاني القديم لأنه يعارضه").',
      'ثم سطر يحتوي فقط على: @@@INSTRUCTIONS@@@',
      'ثم التعليمات الكاملة بعد التعديل (أي عدد أسطر).',
    ].join('\n');
    const user = [
      'التعليمات الحالية:',
      '"""',
      String(currentInstructions || '(لا توجد تعليمات حالية)'),
      '"""',
      '',
      'التعديل المطلوب من التاجر:',
      String(editRequest || ''),
    ].join('\n');

    const res = await openai.chat.completions.create({
      model,
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, { timeout: 30000 });

    const raw = res.choices?.[0]?.message?.content || '';
    const parsed = this._parsePromptEditReply(raw);
    if (!parsed || !String(parsed.newInstructions || '').trim()) {
      throw new Error('لم أفهم التعديل (prompt edit: unparseable model output)');
    }
    return {
      newInstructions: String(parsed.newInstructions).trim(),
      summary: String(parsed.summary || 'تم تحديث التعليمات').trim(),
    };
  }

  // Primary: delimiter protocol (robust to multi-line Arabic). Fallback: JSON,
  // for resilience if a model still answers in the old JSON shape.
  _parsePromptEditReply(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const marker = /^[ \t>*_#-]*@@@\s*INSTRUCTIONS\s*@@@[ \t]*$/im;
    const m = text.match(marker);
    if (m && m.index !== undefined) {
      const before = text.slice(0, m.index).trim();
      const after = text.slice(m.index + m[0].length).trim();
      if (after) {
        const summary = before
          .replace(/^(ملخص[^:：]*[:：]|summary[:：])/i, '')
          .split('\n').map(s => s.trim()).filter(Boolean).pop() || 'تم تحديث التعليمات';
        return { newInstructions: after, summary };
      }
    }

    const json = this._parsePromptEditJson(text);
    if (json) return json;
    return null;
  }

  _parsePromptEditJson(raw) {
    const text = String(raw || '').trim();
    try { return JSON.parse(text); } catch (_) { /* try to extract */ }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fallthrough */ } }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* fallthrough */ }
    }
    return null;
  }
}

AIClient.resolveEffectiveModel = resolveEffectiveModel;
module.exports = AIClient;
