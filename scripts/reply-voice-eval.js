'use strict';

/**
 * Reply Voice Eval — before/after harness (offline; NO WhatsApp send, NO DB write).
 *
 * Runs the REAL bot brain (lib/ai-client getReply) over a set of scripted
 * customer messages, once with the CURRENT production behavior (flags OFF) and
 * once with the NEW behavior (flags ON), and prints both replies side by side
 * so you can SEE the difference in dialect, length, and confidence.
 *
 * It only calls the AI model. It does not connect to WhatsApp and does not
 * write to the database. Safe to run anywhere a model key is available.
 *
 * USAGE (where an OpenAI-compatible key exists, e.g. Railway shell or a machine
 * with the production .env):
 *
 *   OPENAI_API_KEY=sk-... node scripts/reply-voice-eval.js
 *
 * Optional: MODEL=gpt-4o  (defaults to the sample config's model)
 *
 * The sample config mimics a Saudi subscription store (short Saudi dialect, a
 * documented "ضمان" policy). Swap SAMPLE_CONFIG for a real merchant config if
 * you want to eval an exact account (read-only).
 */

const AIClient = require('../lib/ai-client');

const NEW_PATH_FLAGS = {
  AI_SAMPLING_PENALTIES_ENABLED: 'false',
  AI_DRAFT_TEMPERATURE: '0.3',
  PROMPT_STYLE_SPLIT_ENABLED: 'true',
  BREVITY_AUTHORITY_ENABLED: 'true',
  REVIEW_PASSTHROUGH_ENABLED: 'true',
};

const LEGACY_FLAGS = {
  AI_SAMPLING_PENALTIES_ENABLED: undefined,
  AI_DRAFT_TEMPERATURE: undefined,
  PROMPT_STYLE_SPLIT_ENABLED: undefined,
  BREVITY_AUTHORITY_ENABLED: undefined,
  REVIEW_PASSTHROUGH_ENABLED: undefined,
};

const SAMPLE_CONFIG = {
  storeName: 'متجر جواب',
  model: process.env.MODEL || 'gpt-4o',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  maxResponseLength: 220,
  botInstructions:
    'أنت موظف خدمة عملاء سعودي لمتجر اشتراكات. لهجتك سعودية خفيفة وطبيعية، ' +
    'ردودك قصيرة ومباشرة بدون حشو. الاشتراك رسمي ومضمون. لا تسأل العميل ' +
    '"تحتاج شي ثاني" ولا تكرر عبارات المجاملة.',
  products: [
    { name: 'اشتراك شهري', price: '10 ريال', description: 'اشتراك رسمي ومضمون' },
  ],
  autoReplyKeywords: {
    'ضمان': 'نعم الاشتراك رسمي ومضمون ولا يُقفل.',
    'شحن': 'الاشتراك رقمي يوصلك فوراً بعد الدفع.',
  },
  escalationContacts: [{ name: 'الإدارة', phone: '', when: 'طلب مختص' }],
  replyStyle: {
    tone: 'ودي ومحترم', useDialect: true, dialect: 'السعودية الخفيفة',
    emojiLevel: 'none', replyLength: 'short', useShortReplies: true,
    lineBreakMode: 'connected', avoidPhrases: [],
  },
};

const SCENARIOS = [
  { title: 'تحية + سؤال (لهجة + لا يكتفي بالتحية)', text: 'السلام عليكم، وش عندكم؟' },
  { title: 'معلومة موثّقة (الجزم بدل التحفّظ)', text: 'الاشتراك مضمون؟' },
  { title: 'أسئلة متعددة (الاختصار)', text: 'كم السعر؟ وكم يوصل؟ وفيه ضمان؟' },
  { title: 'إنهاء (بدون سؤال حشو)', text: 'تمام شكراً يعطيك العافية' },
];

function applyFlags(flags) {
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function replyWith(flags, customerText) {
  applyFlags(flags);
  const ai = new AIClient({ ...SAMPLE_CONFIG }, { info() {}, warn() {}, error() {} });
  const history = [{ role: 'user', content: customerText }];
  try {
    const out = await ai.getReply(history, { isFirstMsg: true, latestUserText: customerText });
    return String(out || '').trim();
  } catch (err) {
    return `⚠️ خطأ: ${err.message}`;
  }
}

async function main() {
  if (!SAMPLE_CONFIG.openaiApiKey && !SAMPLE_CONFIG.openrouterApiKey) {
    console.error('\n❌ ما فيه مفتاح AI. شغّل هكذا:\n   OPENAI_API_KEY=sk-... node scripts/reply-voice-eval.js\n');
    process.exit(1);
  }
  console.log('\n=== تقييم صوت الردود: قبل (الإنتاج الحالي) مقابل بعد (الجديد) ===\n');
  for (const s of SCENARIOS) {
    console.log('────────────────────────────────────────────────────────');
    console.log(`السيناريو: ${s.title}`);
    console.log(`العميل: ${s.text}`);
    const before = await replyWith(LEGACY_FLAGS, s.text);
    const after = await replyWith(NEW_PATH_FLAGS, s.text);
    console.log(`\n  ◀ قبل (${before.length} حرف): ${before}`);
    console.log(`  ▶ بعد (${after.length} حرف): ${after}\n`);
  }
  console.log('────────────────────────────────────────────────────────');
  console.log('انتهى. قارن: لهجة أقرب لك؟ أقصر؟ يجزم بالضمان؟ بدون حشو خاتمة؟\n');
}

main();
