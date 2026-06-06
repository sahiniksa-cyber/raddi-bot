# Merchant Data + Style Fidelity Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** يلتزم البوت ببيانات منتجات التاجر (حتى أسماء فيها أرقام مثل "4 أشهر") وبأسلوبه (لا نقاط، لا عبارات "كيف أساعدك/أخدمك") — مُثبَت بقبل/بعد على gpt-4o.

**Architecture:** إصلاحان جذريان مستقلان: (أ) **البيانات** — إصلاح مُحلّل المنتجات المكتوبة في البرومنت في `product-knowledge.js` ليكفّ عن رمي الأسطر التي تحوي أرقاماً؛ (ب) **الأسلوب** — فلتر حتمي بعد التوليد في `reply-validator.js` يمسك عبارات عرض-الخدمة الآلية مهما التفّ النموذج لفظياً، + سطر منع على مستوى الفكرة في البرومنت. كلاهما بـTDD.

**Tech Stack:** Node.js v24، `node:test` + `node:assert/strict`، CommonJS. تشغيل: `node --test`.

**جذر مؤكَّد بالدليل:** `isProductNameLine` (product-knowledge.js:36) فيها `if (/\d/.test(value)) return false;` ترمي أي اسم منتج فيه رقم → "اشتراك 4 أشهر" يختفي من الكتالوج → البوت يقول "مافيه". والأسلوب يصل البرومنت لكن النموذج لا يلتزم (يلتف: منعنا "أساعدك" فقال "أخدمك").

---

## File Structure

| ملف | مسؤولية | إنشاء/تعديل |
|---|---|---|
| `src/services/products/product-knowledge.js` | كشف سطر السعر + إصلاح تمييز اسم المنتج + التقاط السعر | تعديل |
| `tests/product-knowledge-digit-names.test.js` | اختبارات إصلاح البيانات | إنشاء |
| `src/services/ai/reply-validator.js` | فلتر أسلوب حتمي `stripStyleViolations` + دمجه في `validateAndRepair` | تعديل |
| `tests/reply-validator.test.js` | اختبارات الفلتر الأسلوبي | تعديل |
| `lib/ai-client.js` | سطر منع على مستوى الفكرة (عبارات عرض الخدمة) | تعديل |
| `scripts/eval/data-style-eval.js` | إثبات قبل/بعد على gpt-4o | إنشاء |

---

## Task 1: كاشف سطر السعر `isPriceLikeLine` + إصلاح `isProductNameLine`

**Files:**
- Modify: `src/services/products/product-knowledge.js:31-40`
- Test: `tests/product-knowledge-digit-names.test.js`

- [ ] **Step 1: اكتب الاختبار الفاشل**

أنشئ `tests/product-knowledge-digit-names.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePromptProducts } = require('../src/services/products/product-knowledge');

const PROMPT = `انت موظف لطيف.

## المنتجات
اشتراك 4 أشهر
120 ريال
اشتراك سنة
350 ريال`;

test('digit-named product ("4 أشهر") is NOT dropped from prompt products', () => {
  const products = parsePromptProducts(PROMPT);
  const names = products.map(p => p.name);
  assert.ok(names.includes('اشتراك 4 أشهر'), `expected "اشتراك 4 أشهر" in ${JSON.stringify(names)}`);
  assert.ok(names.includes('اشتراك سنة'));
});

test('price line is captured as price, not treated as a product name', () => {
  const products = parsePromptProducts(PROMPT);
  const sub = products.find(p => p.name === 'اشتراك 4 أشهر');
  assert.equal(sub.price, '120 ريال');
  // "120 ريال" must NOT appear as its own product name
  assert.ok(!products.some(p => p.name === '120 ريال'));
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/product-knowledge-digit-names.test.js`
Expected: FAIL — "اشتراك 4 أشهر" مفقود (رُمي بسبب الرقم)، و`price` فارغ.

- [ ] **Step 3: نفّذ كاشف السعر وأصلح تمييز الاسم**

في `src/services/products/product-knowledge.js`، أضف قبل `isProductNameLine` (حوالي السطر 31):
```js
// سطر "سعر صرف": يحوي رقماً ولا يتبقى منه حروف بعد إزالة الأرقام والعملة والفواصل.
// "120 ريال" → true ، "اشتراك 4 أشهر" → false (تبقى حروف).
function isPriceLikeLine(value) {
  const v = String(value || '');
  if (!/\d/.test(v)) return false;
  const lettersLeft = v
    .replace(/ر\.?\s?س|ريال|درهم|sar|aed|usd|\$|﷼/gi, '')
    .replace(/[\d.,،\-\/\s]/g, '');
  return lettersLeft.length === 0;
}
```
ثم داخل `isProductNameLine` استبدل السطر:
```js
  if (/\d/.test(value)) return false;
```
بـ:
```js
  if (isPriceLikeLine(value)) return false;
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/product-knowledge-digit-names.test.js`
Expected: اختبار الاسم يمر؛ اختبار السعر قد يبقى فاشلاً (price فارغ) — يُكمَل في Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/services/products/product-knowledge.js tests/product-knowledge-digit-names.test.js
git commit -m "fix(products): keep digit-named product names (4 أشهر) via isPriceLikeLine"
```

---

## Task 2: التقاط السعر في `parsePromptProducts` + قبول منتج بلا وصف

**Files:**
- Modify: `src/services/products/product-knowledge.js:48-74`
- Test: `tests/product-knowledge-digit-names.test.js`

- [ ] **Step 1: الاختبار موجود (price + لا يُسقط منتجاً بلا وصف)**

نستخدم اختبار "price line is captured" من Task 1. أضف اختباراً إضافياً:
```js
test('product with only name+price (no description) is kept', () => {
  const products = parsePromptProducts(`## المنتجات\nاشتراك 4 أشهر\n120 ريال`);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'اشتراك 4 أشهر');
  assert.equal(products[0].price, '120 ريال');
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/product-knowledge-digit-names.test.js`
Expected: FAIL — `price` فارغ، والمنتج بلا وصف يُسقَط (الفلتر القديم يتطلب `name && description`).

- [ ] **Step 3: نفّذ**

استبدل دالة `parsePromptProducts` بالكامل بـ:
```js
function parsePromptProducts(instructions) {
  const section = extractProductSection(instructions);
  if (!section) return [];

  const products = [];
  let current = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isProductNameLine(line)) {
      if (current) products.push(current);
      current = { name: line, descriptionLines: [], price: '', source: 'prompt' };
      continue;
    }
    if (current) {
      if (!current.price && isPriceLikeLine(line)) current.price = line;
      else current.descriptionLines.push(line);
    }
  }
  if (current) products.push(current);

  return products
    .map(product => ({
      name: product.name,
      description: product.descriptionLines.join('\n').trim(),
      price: product.price || '',
      source: product.source,
    }))
    .filter(product => product.name);
}
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/product-knowledge-digit-names.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: تأكد من عدم الانحدار في اختبارات المنتجات القائمة**

Run: `node --test tests/ai-prompt-rules.test.js`
Expected: PASS (اختبار "أدوبي كريتيف كلاود" لا يتأثر سلباً).

- [ ] **Step 6: Commit**

```bash
git add src/services/products/product-knowledge.js tests/product-knowledge-digit-names.test.js
git commit -m "fix(products): capture price line + keep name-only prompt products"
```

---

## Task 3: تكامل — المنتج ذو الرقم يظهر في سياق المنتجات المطابقة

**Files:**
- Test: `tests/product-knowledge-digit-names.test.js`

- [ ] **Step 1: اكتب اختبار التكامل الفاشل**

أضف إلى `tests/product-knowledge-digit-names.test.js`:
```js
const { buildRelevantProductContext, findRelevantProducts } = require('../src/services/products/product-knowledge');

test('customer asking about "4 اشهر" finds the digit-named product', () => {
  const config = { products: [], botInstructions: `## المنتجات\nاشتراك 4 أشهر\n120 ريال\nاشتراك سنة\n350 ريال` };
  const found = findRelevantProducts(config, 'عندكم اشتراك 4 اشهر؟');
  assert.ok(found.some(p => p.name === 'اشتراك 4 أشهر'), `got ${JSON.stringify(found.map(p=>p.name))}`);
  const ctx = buildRelevantProductContext({ config, customerText: 'عندكم اشتراك 4 اشهر؟' });
  assert.match(ctx, /4 أشهر/);
  assert.match(ctx, /120/);
});
```

- [ ] **Step 2: شغّل**

Run: `node --test tests/product-knowledge-digit-names.test.js`
Expected: PASS (بعد إصلاح Task 1+2، المنتج صار في الكتالوج فيُطابَق). إذا فشل المطابقة، فالسبب scoreProduct — انتقل للخطوة 3.

- [ ] **Step 3: (إن لزم) عزّز التطابق للأرقام في `scoreProduct`**

إن فشل التطابق، في `scoreProduct` (السطر ~128) خفّض حدّ طول التوكن ليشمل أرقاماً قصيرة:
```js
  const tokens = query.split(' ').filter(token => token.length >= 2);
```
(كان `>= 3`؛ التخفيض لـ`>= 2` يجعل "4" و"6" توكنات قابلة للمطابقة). أعد تشغيل الاختبار.

- [ ] **Step 4: Commit**

```bash
git add tests/product-knowledge-digit-names.test.js src/services/products/product-knowledge.js
git commit -m "test(products): digit-named product surfaces in relevant context"
```

---

## Task 4: فلتر الأسلوب الحتمي `stripStyleViolations`

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: اكتب الاختبار الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
const { stripStyleViolations } = require('../src/services/ai/reply-validator');

test('stripStyleViolations removes "كيف أقدر أساعدك" variants', () => {
  assert.equal(stripStyleViolations('وعليكم السلام! كيف أقدر أساعدك اليوم؟').includes('أساعدك'), false);
  assert.equal(stripStyleViolations('هلا! كيف أقدر أخدمك اليوم؟').includes('أخدمك'), false);
  assert.equal(stripStyleViolations('أهلين، كيف يمكنني مساعدتك؟').includes('مساعدتك'), false);
});
test('stripStyleViolations keeps normal content intact', () => {
  const r = 'الشحن يوصل خلال يومين عبر سمسا';
  assert.equal(stripStyleViolations(r), r);
});
test('stripStyleViolations leaves a clean greeting when offer-help removed', () => {
  const out = stripStyleViolations('وعليكم السلام! كيف أقدر أخدمك اليوم؟');
  assert.ok(out.startsWith('وعليكم السلام'));
  assert.ok(out.length > 0);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — `stripStyleViolations is not a function`.

- [ ] **Step 3: نفّذ**

أضف إلى `src/services/ai/reply-validator.js` (وحدّث module.exports):
```js
// يمسك عبارة "عرض الخدمة" الآلية مهما التفّ النموذج لفظياً
// (أساعدك/أخدمك/أعاونك/مساعدتك/خدمتك)، حتمياً قبل الإرسال.
const OFFER_HELP = /\s*،?\s*(?:كيف|كيفاش|وش)\s+(?:أقدر|اقدر|يمكنني|ممكن|تحب|تبي)?\s*(?:أ|ا)?(?:ساعد|خدم|عاون)\S*\s*(?:اليوم|حضرتك)?\s*[؟?]*/g;

function stripStyleViolations(reply) {
  let out = String(reply || '').replace(OFFER_HELP, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([،.!؟])/g, '$1').trim();
  // نظّف علامة ترقيم متدلية في النهاية (مثل "! ," بعد الحذف)
  out = out.replace(/[،,]\s*$/,'').replace(/!\s*$/,'!').trim();
  return out;
}

module.exports = {
  enforceLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair, stripStyleViolations,
};
```
> ملاحظة: احرص أن `module.exports` النهائي يضم كل الدوال السابقة + `stripStyleViolations`.

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل، شامل الـ26 القائمة).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): deterministic stripStyleViolations for robotic offer-help phrases"
```

---

## Task 5: دمج الفلتر في `validateAndRepair` + سطر منع على مستوى الفكرة

**Files:**
- Modify: `src/services/ai/reply-validator.js` (داخل `validateAndRepair`)
- Modify: `lib/ai-client.js` (نص `knowledgeRules`)
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: اكتب اختبار الدمج الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
test('validateAndRepair strips offer-help phrase deterministically', async () => {
  const out = await validateAndRepair({
    reply: 'وعليكم السلام! كيف أقدر أخدمك اليوم؟',
    config: {}, customerText: 'السلام عليكم', matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.equal(/أخدمك|أساعدك/.test(out), false);
  assert.ok(out.includes('السلام'));
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — العبارة الآلية ما زالت موجودة (الفلتر غير مدموج).

- [ ] **Step 3: ادمج الفلتر في `validateAndRepair`**

في `validateAndRepair` (داخل `src/services/ai/reply-validator.js`)، بعد سطر إصلاح التهرّب وقبل `enforceEscalationTag`، أضف:
```js
  // فلتر أسلوب حتمي (يمسك عبارات عرض الخدمة الآلية)
  current = stripStyleViolations(current);
```
(الترتيب النهائي: cop-out repair → stripStyleViolations → فصل علامة التصعيد → enforceLength → إعادة إلصاق العلامة، حسب منطق I1 القائم.)

- [ ] **Step 4: أضف سطر المنع على مستوى الفكرة في البرومنت**

في `lib/ai-client.js`، داخل نص `knowledgeRules` (حوالي السطر 126-132)، أضف سطراً جديداً قبل سطر "مثال خاطئ":
```js
- ممنوع أي عبارة عرض خدمة عامة أو آلية (مثل "كيف أقدر أساعدك/أخدمك"، "كيف يمكنني مساعدتك"). بدلاً منها اسأل سؤالاً ملموساً عن طلب العميل أو ادخل في صلب الموضوع مباشرة.
```

- [ ] **Step 5: شغّل للتأكد من النجاح + عدم الانحدار**

Run: `node --test tests/reply-validator.test.js tests/ai-prompt-rules.test.js tests/ai-client-knowledge-injection.test.js`
Expected: PASS الكل.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/reply-validator.js lib/ai-client.js tests/reply-validator.test.js
git commit -m "feat(ai): wire style filter into validateAndRepair + concept-level prompt ban"
```

---

## Task 6: إثبات قبل/بعد على gpt-4o + تشغيل الحزمة

**Files:**
- Create: `scripts/eval/data-style-eval.js`

- [ ] **Step 1: أنشئ harness الإثبات**

أنشئ `scripts/eval/data-style-eval.js` يبني config مطابقاً لشاشة التاجر (employeeName محمد، tone مرح ولطيف، dialect حجازية، maxResponseLength 100، responseLanguage عربية حجازية بسيطة) مع منتجات في البرومنت تشمل "اشتراك 4 أشهر | 120 ريال"، ثم يستدعي `new AIClient(config).getReply(...)` على `gpt-4o` لسؤالين:
1. "عندكم اشتراك 4 اشهر؟" → يجب أن يذكر 120 (لا "مافيه").
2. "السلام عليكم" → يجب ألا يحتوي "كيف أقدر أساعدك/أخدمك" ولا نقاط.
يشغّل كل سؤال **مرتين**: مرة بـ`REPLY_VALIDATOR_ENABLED=false` و`KNOWLEDGE_INJECTION_ENABLED=false` (قبل)، ومرة بالافتراضي (بعد)، ويطبع الفرق. المفتاح من `process.env.EVAL_API_KEY`. لا يدخل CI.
```js
'use strict';
// تشغيل يدوي: EVAL_API_KEY=... node scripts/eval/data-style-eval.js
const path = require('path');
const AIClient = require(path.join(__dirname,'..','..','lib','ai-client'));
const { DEFAULT_CONFIG } = require(path.join(__dirname,'..','..','lib','constants'));
const KEY = process.env.EVAL_API_KEY;
if (!KEY) { console.error('set EVAL_API_KEY'); process.exit(1); }
const baseConfig = {
  ...DEFAULT_CONFIG, model: 'gpt-4o', openaiApiKey: KEY,
  storeName: 'متجري', responseLanguage: 'عربية حجازية بسيطة', maxResponseLength: 100,
  replyStyle: { ...DEFAULT_CONFIG.replyStyle, employeeName: 'محمد', tone: 'مرح ولطيف', useDialect: true, dialect: 'السعودية - الحجازية', emojiLevel: 'medium', replyLength: 'short', useShortReplies: true },
  products: [],
  botInstructions: 'انت موظف خدمة عملاء لطيف اسمك محمد، ودود ومختصر وما تستخدم نقاط.\n\n## المنتجات\nاشتراك 4 أشهر\n120 ريال\nاشتراك سنة\n350 ريال',
};
const logger = { info(){}, warn(){}, error(){} };
async function ask(q) {
  const ai = new AIClient(baseConfig, logger, { record(){} });
  return String(await ai.getReply([{ role:'user', content:q }], { isFirstMsg:true }) || '').trim();
}
(async () => {
  for (const flag of ['false','true']) {
    process.env.KNOWLEDGE_INJECTION_ENABLED = flag;
    process.env.REPLY_VALIDATOR_ENABLED = flag;
    console.log('\n===== ' + (flag==='false'?'قبل (الطبقات مطفأة)':'بعد (الطبقات مفعّلة)') + ' =====');
    console.log('Q1 "4 اشهر":', await ask('عندكم اشتراك 4 اشهر؟'));
    console.log('Q2 تحية   :', await ask('السلام عليكم'));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
```

- [ ] **Step 2: شغّل الحزمة الكاملة (عدم انحدار)**

Run: `node --test`
Expected: لا فشل جديد (عدا `runtime-bot-stability-fixes.test.js` البيئي الذي يحتاج Postgres/Redis).

- [ ] **Step 3: Commit**

```bash
git add scripts/eval/data-style-eval.js
git commit -m "chore(eval): before/after harness for data + style fidelity"
```

- [ ] **Step 4: (يدوي بمفتاح) شغّل الإثبات قبل/بعد**

Run: `EVAL_API_KEY=<key> node scripts/eval/data-style-eval.js`
Expected: "قبل" → Q1 يقول مافيه/يتهرّب، Q2 فيه "كيف أقدر أخدمك"؛ "بعد" → Q1 يذكر 120، Q2 بلا عبارة آلية.

---

## Self-Review

- **تغطية:** البيانات (Tasks 1-3) تعالج رمي المنتجات ذات الأرقام + التقاط السعر + ظهورها في السياق. الأسلوب (Tasks 4-5) فلتر حتمي + منع مفاهيمي. الإثبات (Task 6) يغطي مشكلتي المستخدم بالضبط قبل/بعد.
- **Placeholder scan:** لا TODO في أكواد التنفيذ.
- **اتساق الأنواع:** `isPriceLikeLine` تُستخدم في `isProductNameLine` و`parsePromptProducts` (Tasks 1-2). `stripStyleViolations` معرّفة في Task 4 وتُدمج في Task 5. `parsePromptProducts` ترجع `{name,description,price,source}` متسقة مع `structuredProducts`/`mergeProducts` القائمة.
- **مخاطر:** تخفيض حدّ توكن `scorePolicy`... لا — هذا `scoreProduct` (Task 3 خطوة 3) وهو مشروط "إن لزم". `OFFER_HELP` regex قد يكون عدوانياً — اختباراته تتأكد أنه لا يمسّ محتوى عادياً ("الشحن يوصل..."). إن ظهر false-positive لاحقاً، يُضيَّق في جلسة مراقبة.
