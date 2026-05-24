# AI Prompts Cleanup + Custom Avoid Phrases — Design Spec

**Date:** 2026-05-25
**Status:** Approved

---

## المشكلة

صاحب المتجر يشتكي أن الـ AI:
1. يستخدم علامات تنصيص حول كلامه (مثل: `"السعر 99 ريال"`) رغم أنه طلب صراحة في التعليمات ألا يفعل
2. يختم ردوده بعبارات نمطية شائعة مثل "إذا عندك أي استفسار أنا موجود" و "في خدمتك" حتى لو حُذِّر منها
3. عموماً لا يلتزم بالقواعد السلبية ("لا تقل X")

**التحليل التقني:**

في [lib/ai-client.js:124, 142, 178](lib/ai-client.js:124) الـ system prompt يحتوي على علامات تنصيص داخلية:
```js
ابدأ ردّك بترحيب طبيعي بنفس روح: "${this.config.welcomeMessage}"
اكتب عفوي بشري: "ثانية بس"، "خلني أشوف"، "والله"
مثلاً: "خلني أحوّلك للمختص"
```

النتيجة: الـ AI يقلّد ما يشوف. الـ priming effect قوي في كل الـ LLMs — لما الموديل يشوف علامات تنصيص في تعليماته، يستنتج أنها style مقبول.

أيضاً، عبارات الخدمة الشائعة ("إذا عندك أي استفسار...") مُدرَّبة عليها الموديل بقوة من ملايين محادثات RLHF — صعب يتركها بمجرد توجيه سلبي.

---

## الهدف

**1.** إزالة الـ priming effect من الـ system prompt (تنظيف داخلي للكود).
**2.** إعطاء صاحب المتجر **تحكم كامل من الدashboard** بالعبارات الممنوعة، مع post-processing filter يضمن **enforcement بنسبة 100%** (لا يعتمد على طاعة الموديل).
**3.** Backwards-compatible — البوتات الحالية تستمر بدون أي إعدادات جديدة.

---

## مبادئ التصميم (تأكيد من المستخدم)

> "ما دام ما فيه أي صلاحيات في البرمجة، كلها في المنصة. والبوت يسمع الكلام اللي في المنصة. علامات التنصيص وطول الرد كله يتم تحديده في المنصة."

- **حرية كاملة لصاحب المتجر:** كل ما يخص سلوك البوت تجاه العميل يُتحكَّم به من الدashboard
- **الكود يُصلح المشاكل العامة:** تنظيف الـ priming لا يحتاج توجيه من المستخدم — هذا bug جذري في الـ prompt
- **post-processing deterministic:** ما يطلب من الموديل أن "يطيع" — الفلتر يحذف بعد التوليد

---

## مكوّن 1: تنظيف `buildSystemPrompt` (كود فقط)

ملف واحد يتغير: `lib/ai-client.js` (دالة `buildSystemPrompt`).

### تغيير 1: شيل علامات التنصيص الداخلية

**موضع 1** — `welcomeHint` (السطر 124):
```js
// قبل
`\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي بنفس روح: "${this.config.welcomeMessage}" ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`

// بعد
`\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي مشابه لـ ⟪${this.config.welcomeMessage}⟫ ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
```

استخدام `⟪⟫` (Mathematical Left/Right White Bracket) كـ delimiter بدل علامات الاقتباس — رمز نادر لا يقلده الـ AI بشكل عفوي.

**موضع 2** — `productsBlock` fallback (السطر 114):
```js
// قبل
'(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، قل: "خلني أتأكد لك من التوفر")'

// بعد
'(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، أجب بأنك ستتأكد من التوفر وتعود إليه)'
```

**موضع 3** — `escalationBlock` (السطر 140-142):
```js
// قبل
طريقة التحويل: أجب العميل أولاً (مثلاً: "خلني أحوّلك للمختص")، ثم يجب أن تضيف...
مثال: خلني أحوّلك لأحمد يساعدك بالموضوع [تحويل:أحمد|...]

// بعد
طريقة التحويل: أجب العميل أولاً بجملة تشرح أنك ستحوّله للمختص، ثم يجب أن تضيف...
مثال: خلني أحوّلك لأحمد يساعدك بالموضوع [تحويل:أحمد|...]
```

**موضع 4** — default prompt (السطر 160):
```js
// قبل
أنت إنسان حقيقي. لو سُئلت "هل أنت بوت؟" قل: "لا، أنا ${employeeName} من فريق ${this.config.storeName || 'المتجر'}".

// بعد
أنت إنسان حقيقي. لو سُئلت إن كنت بوتاً، أكّد أنك ${employeeName} من فريق ${this.config.storeName || 'المتجر'}.
```

**موضع 5** — أسلوب الرد (السطر 178):
```js
// قبل
- اكتب عفوي بشري: "ثانية بس"، "خلني أشوف"، "والله"

// بعد
- اكتب بأسلوب بشري عفوي مثل: ثانية بس / خلني أشوف / والله
```

**موضع 6** — تنسيق الرد (السطر 184):
```js
// قبل
- تجنب رموز Markdown الكتابية (** ## --- |جداول|)

// بعد
- تجنب رموز Markdown الكتابية (** ## --- جداول)
```

### تغيير 2: تحويل القواعد لإيجابية + قاعدة صريحة ضد الاقتباس

في موضع `🚫 ممنوع` (السطر 186-188):

```js
// قبل
🚫 ممنوع:
- قول هذه الكلمات أبداً: ${avoid}
- تكرار الترحيب إذا كنت رحبت في رسالة سابقة

// بعد
✅ القواعد الذهبية:
- اكتب كأنك ترسل رسائل واتساب عادية: بدون علامات اقتباس حول كلامك (لا " ولا ' ولا «»)
- لو رحبت بالعميل سابقاً، انتقل مباشرة للمحتوى بدون إعادة ترحيب
- اختم ردودك بسؤال محدد عن طلب العميل بدل عبارات عامة مثل (إذا عندك أي استفسار)
- لا تستخدم هذه التعبيرات في أي رد: ${avoid}
```

---

## مكوّن 2: عبارات ممنوعة (Dashboard + post-processing)

### Schema

في `lib/constants.js` → `DEFAULT_CONFIG.replyStyle`:
```js
replyStyle: {
  // ... الموجود ...
  avoidPhrases: [],  // جديد — array من العبارات النصية الكاملة
}
```

**لا migration:** الـ field يُحفظ في `bot_configs.config` (JSONB موجود).

### Dashboard UI

في `dashboard/index.html`، بجانب panel "كلمات ممنوعة" الموجود، نضيف panel جديد:

```html
<div class="panel">
  <div class="phdr">✏️ عبارات ممنوعة — البوت لا يقولها أبداً</div>
  <div class="pbdy">
    <p class="hint">اكتب جملة كاملة (مثل: إذا عندك أي استفسار أنا موجود) — البوت يحذفها من رده تلقائياً</p>
    <div id="avoidPhrasesContainer"></div>
    <button class="add-btn" onclick="addAvoidPhrase()">+ إضافة عبارة</button>
  </div>
</div>
```

دالات JS:
- `addAvoidPhrase(value = '')` — تضيف input
- `renderAvoidPhrases(arr)` — تعيد رسم القائمة عند تحميل الإعدادات
- `saveConf()` (موجود) — يضيف `replyStyle.avoidPhrases` إلى payload

### Post-processing filter

ملف جديد: `lib/post-process-reply.js`

```js
'use strict';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeArabicForMatch(s) {
  return String(s || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function stripAvoidedContent(reply, config = {}) {
  if (!reply || typeof reply !== 'string') return reply || '';
  const original = reply;
  let cleaned = reply;

  // 1) شيل علامات الاقتباس المحيطة بكامل الرد أو الأسطر
  cleaned = cleaned.replace(/^[\s]*["'`«»]+\s*/u, '');
  cleaned = cleaned.replace(/\s*["'`«»]+\s*$/u, '');

  // 2) شيل علامات الاقتباس داخل الرد (تحافظ على النص بداخلها)
  cleaned = cleaned.replace(/["«»]/g, '');
  // single quotes: نشيلها إلا لو بين رقمين (مثلاً ' ' في ID)
  cleaned = cleaned.replace(/(?<!\d)['`](?!\d)/g, '');

  // 3) شيل العبارات الممنوعة من config.replyStyle.avoidPhrases
  const phrases = Array.isArray(config?.replyStyle?.avoidPhrases)
    ? config.replyStyle.avoidPhrases.filter(p => typeof p === 'string' && p.trim())
    : [];
  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const normalizedPhrase = normalizeArabicForMatch(trimmed);
    const pattern = new RegExp(escapeRegex(normalizedPhrase), 'gi');
    cleaned = cleaned.split('\n').map(line => {
      const normalizedLine = normalizeArabicForMatch(line);
      if (!pattern.test(normalizedLine)) return line;
      pattern.lastIndex = 0;
      const matches = [...normalizedLine.matchAll(pattern)];
      let result = line;
      for (const m of matches.reverse()) {
        result = result.slice(0, m.index) + result.slice(m.index + trimmed.length);
      }
      return result;
    }).join('\n');
  }

  // 4) تنظيف whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([،.؟!]) ?/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5) Fallback آمن: لو الفلتر حذف كل شي، نرجع الأصل
  if (!cleaned || cleaned.length < 3) return original.trim();

  return cleaned;
}

module.exports = { stripAvoidedContent };
```

### Integration في `lib/ai-client.js`

في `getReply` قبل `return reply;` (السطر 236):

```js
const { stripAvoidedContent } = require('./post-process-reply');
// ...
async getReply(history, opts = {}) {
  // ... الكود الموجود ...
  const reply = res.choices[0]?.message?.content || '';
  // post-processing
  const cleanedReply = stripAvoidedContent(reply, this.config);
  if (cleanedReply !== reply) {
    this.logger.info('ai', `✂️ post-process: ${reply.length} → ${cleanedReply.length}`);
  }
  this.lastDebug.reply = cleanedReply;
  this.lastDebug.success = true;
  return cleanedReply;
}
```

---

## ملفات تتغير

| الملف | التغيير | حجم |
|---|---|---|
| `lib/ai-client.js` | تنظيف `buildSystemPrompt` + integration للـ post-processing | متوسط |
| `lib/post-process-reply.js` (جديد) | دالة `stripAvoidedContent` معزولة | متوسط |
| `lib/constants.js` | إضافة `avoidPhrases: []` في `DEFAULT_CONFIG.replyStyle` | سطر |
| `dashboard/index.html` | panel جديد + 3 دوال JS + integration في `saveConf` و `loadConf` | متوسط |
| `tests/post-process-reply.test.js` (جديد) | 8 اختبارات للفلتر | متوسط |
| `tests/ai-client-prompt.test.js` (جديد) | snapshot test أن الـ prompt لا يحوي علامات تنصيص داخلية | صغير |

**صفر** تغييرات في: DB schema، migrations، queues، Baileys، escalation.

---

## Data Flow

```
[المستخدم يضيف عبارة "إذا عندك استفسار" في الدashboard]
       ↓
[saveConf() → POST /api/save-config → bot_configs.config.replyStyle.avoidPhrases]
       ↓
[رسالة من العميل تصل]
       ↓
[ai-worker يحمل config من DB ويبني AIClient]
       ↓
[AIClient.getReply: prompt نظيف بدون quotes]
       ↓
[Gemini/GPT يرد بـ: "أبشر، السعر 99 ريال. إذا عندك أي استفسار أنا موجود."]
       ↓
[stripAvoidedContent(reply, config)]
   - شيل " المحيطة
   - شيل "إذا عندك أي استفسار أنا موجود" (من avoidPhrases)
   - تنظيف whitespace
       ↓
[reply النهائي: "أبشر، السعر 99 ريال."]
       ↓
[outgoing queue → WhatsApp]
```

---

## اختبارات

### `tests/post-process-reply.test.js`

```js
test('stripAvoidedContent removes wrapping quotes around full reply', () => {
  assert.equal(stripAvoidedContent('"أبشر، السعر 99 ريال"'), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent removes internal quote marks but keeps the text', () => {
  assert.equal(
    stripAvoidedContent('قال العميل "أبي خصم" فأجبته بأنه ممكن'),
    'قال العميل أبي خصم فأجبته بأنه ممكن'
  );
});

test('stripAvoidedContent removes configured avoidPhrases', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك أي استفسار أنا موجود'] } };
  const reply = 'أبشر، السعر 99 ريال. إذا عندك أي استفسار أنا موجود.';
  assert.equal(stripAvoidedContent(reply, config), 'أبشر، السعر 99 ريال. .');
});

test('stripAvoidedContent matches avoidPhrases with Arabic letter variations (همزة/ألف)', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك استفسار'] } };
  // العميل يكتب بدون همزة — الفلتر يطابقها بفضل الـ normalization
  const reply = 'أبشر. اذا عندك استفسار راسلني';
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent returns original when filter removes everything', () => {
  const config = { replyStyle: { avoidPhrases: ['السعر 99 ريال'] } };
  assert.equal(stripAvoidedContent('السعر 99 ريال', config), 'السعر 99 ريال');
});

test('stripAvoidedContent is no-op when config has no avoidPhrases', () => {
  assert.equal(stripAvoidedContent('أبشر، السعر 99 ريال', {}), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent handles null/empty inputs gracefully', () => {
  assert.equal(stripAvoidedContent(null), '');
  assert.equal(stripAvoidedContent(''), '');
});

test('stripAvoidedContent preserves WhatsApp marker like [تحويل:...]', () => {
  const reply = 'خلني أحوّلك للمختص [تحويل:محمد|مشكلة دفع]';
  assert.equal(stripAvoidedContent(reply), reply);
});
```

### `tests/ai-client-prompt.test.js`

```js
const AIClient = require('../lib/ai-client');

test('buildSystemPrompt does not embed quote marks around dynamic content', () => {
  const ai = new AIClient(
    { storeName: 'متجري', welcomeMessage: 'هلا والله', model: 'google/gemini-2.0-flash', googleApiKey: 'xxxxxxxxxxxx' },
    { info: () => {}, warn: () => {} },
    { record: () => {}, save: () => {} }
  );
  const prompt = ai.buildSystemPrompt([], { isFirstMsg: true });
  // الاسم الديناميكي لا يكون محاطاً بـ " "
  assert.ok(!prompt.includes('"هلا والله"'), 'welcomeMessage must not be wrapped in quotes');
  assert.ok(!prompt.includes('"متجري"'), 'storeName must not be wrapped in quotes');
});
```

---

## ضمانات الأمان

1. **الفلتر لا يكسر أي رد** — لو شال كل شي يرجع الأصل
2. **الـ marker `[تحويل:...]` محفوظ** — الـ regex ما يلامسه
3. **Backwards-compatible** — `avoidPhrases` غير موجود → الفلتر فقط يشيل علامات الاقتباس (تحسين بسيط آمن للكل)
4. **DB JSONB** — لا migration، لا تأثير على بوتات موجودة
5. **Snapshot test** — يضمن أن الـ prompt الجديد ما يحوي علامات تنصيص داخلية حول variables ديناميكية

---

## ما خارج النطاق

- **Replacement** — الفلتر يحذف فقط، لا يستبدل بشي ثاني (YAGNI)
- **AI training/fine-tuning** — صعب وغالٍ، لا طلب من المستخدم
- **حقول إضافية في الدashboard** غير `avoidPhrases` — `maxResponseLength` وغيرها موجودة بالفعل
- **Phase D (variants)** — مشروع لاحق
