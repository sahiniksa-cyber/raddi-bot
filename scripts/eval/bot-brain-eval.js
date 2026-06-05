'use strict';
/**
 * تقييم يدوي لعقل البوت (Phase 1) — خارج CI تماماً (لا يُستورَد في أي اختبار).
 * يقيس على نموذج حقيقي ما إذا كان الحقن + الـvalidator يحققان عتبات الـspec §2:
 *   - الرد على الردود الفورية عبر إعادة الصياغة (هدف ≥ 95%)
 *   - عدم اختراع سعر (هدف 100%)
 *   - التزام الطول (هدف 100%)
 *
 * التشغيل (PowerShell):  $env:EVAL_API_KEY='sk-...'; node scripts/eval/bot-brain-eval.js
 * التشغيل (bash):        EVAL_API_KEY='sk-...' node scripts/eval/bot-brain-eval.js
 *
 * المفتاح يُقرأ من البيئة فقط ولا يُكتب في أي ملف.
 */
const path = require('path');
const AIClient = require(path.join(__dirname, '..', '..', 'lib', 'ai-client'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'lib', 'constants'));

const KEY = process.env.EVAL_API_KEY;
if (!KEY) { console.error('set EVAL_API_KEY (e.g. EVAL_API_KEY=sk-... node scripts/eval/bot-brain-eval.js)'); process.exit(1); }
const MODEL = process.env.EVAL_MODEL || 'gpt-4o';

// متجر عطور مرجعي (مطابق لسيناريوهات التحقق في الـspec §7)
const config = {
  ...DEFAULT_CONFIG,
  storeName: 'دار العنبر',
  storeDescription: 'متجر عطور وعود فاخر، توصيل لكل المملكة',
  model: MODEL,
  openaiApiKey: KEY,
  maxResponseLength: 300,
  botInstructions: 'أنت خبير عطور اسمك سلطان. أسلوب خليجي راقي ومختصر.',
  products: [
    { name: 'عود كمبودي', price: '450 ريال', description: 'تجربة 3 جرام' },
    { name: 'مسك أبيض', price: '120 ريال' },
  ],
  autoReplyKeywords: {
    'الشحن': 'الشحن مجاني فوق 200 ريال ويوصل خلال 2-4 أيام عبر سمسا',
    'الدفع': 'نوفر الدفع عند الاستلام ومدى وآبل باي',
    'الإرجاع': 'الإرجاع متاح خلال 7 أيام بشرط أن المنتج لم يُفتح',
  },
  escalationContacts: [{ name: 'سلطان', role: 'المالك', phone: '0500000000', when: 'الشكاوى' }],
  replyStyle: { ...DEFAULT_CONFIG.replyStyle, employeeName: 'سلطان', useShortReplies: true, replyLength: 'short' },
};

// السيناريوهات: سؤال بصياغة غير حرفية + كلمة دالة يجب أن تظهر في الرد الصحيح
const SCENARIOS = [
  { q: 'متى يوصلني الطلب؟',            expect: ['سمسا', '2-4', 'أيام'] },
  { q: 'كم ياخذ التوصيل لجدة؟',        expect: ['سمسا', 'أيام'] },
  { q: 'تقبلون كاش عند الباب؟',        expect: ['الاستلام', 'مدى', 'آبل'] },
  { q: 'أقدر أرجع المنتج لو ما عجبني؟', expect: ['7', 'أيام'] },
];

const DEFLECT = /(أأكد لك|بسأل المختص|تسمح لي|من المختص)/;

(async () => {
  const ai = new AIClient(config, { info(){}, warn(){}, error(){} }, { record(){} });
  let pass = 0;
  for (const s of SCENARIOS) {
    const reply = await ai.getReply([{ role: 'user', content: s.q }], { isFirstMsg: true });
    const hit = s.expect.some(k => reply.includes(k));
    const deflected = DEFLECT.test(reply);
    const ok = hit && !deflected;
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} «${s.q}»\n   → ${reply}\n`);
  }
  const pct = Math.round((pass / SCENARIOS.length) * 100);
  console.log(`النتيجة: ${pass}/${SCENARIOS.length} (${pct}%) — عتبة الـspec ≥ 95%`);
  process.exit(pct >= 95 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
