'use strict';
// تشغيل يدوي: EVAL_API_KEY=... node scripts/eval/data-style-eval.js
// إثبات قبل/بعد على gpt-4o لمشكلتي التاجر: (1) منتج "4 أشهر" يقول مافيه، (2) الأسلوب.
const path = require('path');
const AIClient = require(path.join(__dirname, '..', '..', 'lib', 'ai-client'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'lib', 'constants'));

const KEY = process.env.EVAL_API_KEY;
if (!KEY) { console.error('set EVAL_API_KEY'); process.exit(1); }

const baseConfig = {
  ...DEFAULT_CONFIG, model: 'gpt-4o', openaiApiKey: KEY,
  storeName: 'متجري', responseLanguage: 'عربية حجازية بسيطة', maxResponseLength: 100,
  replyStyle: {
    ...DEFAULT_CONFIG.replyStyle, employeeName: 'محمد', tone: 'مرح ولطيف',
    useDialect: true, dialect: 'السعودية - الحجازية', emojiLevel: 'medium',
    replyLength: 'short', useShortReplies: true,
  },
  products: [],
  botInstructions: 'انت موظف خدمة عملاء لطيف اسمك محمد، ودود ومختصر وما تستخدم نقاط.\n\n## المنتجات\nاشتراك 4 أشهر\n120 ريال\nاشتراك سنة\n350 ريال',
};
const logger = { info(){}, warn(){}, error(){} };

async function ask(q) {
  const ai = new AIClient(baseConfig, logger, { record(){} });
  return String(await ai.getReply([{ role: 'user', content: q }], { isFirstMsg: true }) || '').trim();
}

(async () => {
  for (const flag of ['false', 'true']) {
    process.env.KNOWLEDGE_INJECTION_ENABLED = flag;
    process.env.REPLY_VALIDATOR_ENABLED = flag;
    console.log('\n===== ' + (flag === 'false' ? 'قبل (الطبقات مطفأة)' : 'بعد (الطبقات مفعّلة)') + ' =====');
    console.log('Q1 "عندكم اشتراك 4 اشهر؟" →', await ask('عندكم اشتراك 4 اشهر؟'));
    console.log('Q2 "السلام عليكم"        →', await ask('السلام عليكم'));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
