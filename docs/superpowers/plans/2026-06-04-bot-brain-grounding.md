# Bot Brain — Grounding + Validation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** اجعل البوت يعتمد على معرفة المنصة بثبات: يحقن الردود الفورية (السياسات) في الـsystem prompt، ويتحقق من الرد بعد التوليد (طول، تهرّب، اختراع سعر، تصعيد) — دون كود خاص بأي تاجر.

**Architecture:** ثلاث وحدات مستقلة قابلة للاختبار offline: (L1) `knowledge-retrieval.js` يطابق سؤال العميل مع السياسات ويبني كتلة مُقيَّدة؛ تُدمج الكتلة في `buildSystemPrompt` خلف feature flag؛ (L4) `reply-validator.js` فحوصات حتمية + إصلاح واحد. كل طبقة خلف flag للإطفاء الفوري.

**Tech Stack:** Node.js v24، `node:test` + `node:assert/strict`، CommonJS. لا تبعيات جديدة. تشغيل الاختبارات: `node --test`.

**مبدأ السلامة:** كل طبقة خلف متغيّر بيئة. الافتراضي ON، لكن أي مشكلة في الإنتاج = ضبط الـflag على `false` يعيد السلوك القديم فوراً. الفحوصات الحتمية محافِظة: تنحاز لعدم إفساد رد سليم.

---

## File Structure

| ملف | مسؤولية | إنشاء/تعديل |
|---|---|---|
| `lib/post-process-reply.js` | تصدير `normalizeArabic` لإعادة استخدامها (DRY) | تعديل (سطر export فقط) |
| `src/services/ai/knowledge-retrieval.js` | تطبيع/توكنايز/مرادفات/درجة الصلة + بناء كتلة السياسات | إنشاء |
| `lib/ai-client.js` | دمج كتلة السياسات في `buildSystemPrompt` (المسارين) خلف flag | تعديل |
| `src/services/ai/reply-validator.js` | فحوصات حتمية + `validateAndRepair` | إنشاء |
| `lib/ai-client.js` (`getReply`) | استدعاء `validateAndRepair` بعد `stripAvoidedContent` خلف flag | تعديل |
| `tests/knowledge-retrieval.test.js` | اختبارات L1 | إنشاء |
| `tests/ai-client-knowledge-injection.test.js` | اختبار دمج L1 في البرومنت | إنشاء |
| `tests/reply-validator.test.js` | اختبارات L4 | إنشاء |

---

## Task 1: تصدير `normalizeArabic` لإعادة الاستخدام (DRY)

**Files:**
- Modify: `lib/post-process-reply.js:87`

- [ ] **Step 1: عدّل سطر التصدير**

في نهاية الملف، استبدل:
```js
module.exports = { stripAvoidedContent };
```
بـ:
```js
module.exports = { stripAvoidedContent, normalizeArabic };
```

- [ ] **Step 2: تأكد أن الاختبارات القائمة ما زالت تمر**

Run: `node --test tests/post-process-reply.test.js 2>nul & node --test`
Expected: لا فشل جديد (التصدير الإضافي لا يكسر شيئاً).

- [ ] **Step 3: Commit**

```bash
git add lib/post-process-reply.js
git commit -m "refactor: export normalizeArabic for reuse"
```

---

## Task 2: نواة الاسترجاع — tokenize + المرادفات + الدرجة

**Files:**
- Create: `src/services/ai/knowledge-retrieval.js`
- Test: `tests/knowledge-retrieval.test.js`

- [ ] **Step 1: اكتب الاختبار الفاشل**

أنشئ `tests/knowledge-retrieval.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, scorePolicy } = require('../src/services/ai/knowledge-retrieval');

test('tokenize normalizes arabic and drops stopwords + short tokens', () => {
  const t = tokenize('متى يوصلني الطلب في الرياض؟');
  assert.ok(t.includes('يوصلني'));
  assert.ok(t.includes('الطلب') || t.includes('طلب'));
  assert.ok(!t.includes('في'));      // stopword
});

test('scorePolicy gives high score when synonym of keyword appears', () => {
  // التاجر كتب المفتاح "الشحن"؛ العميل قال "يوصلني" (مرادف)
  const score = scorePolicy('متى يوصلني الطلب؟', 'الشحن', 'الشحن مجاني ويوصل خلال 2-4 أيام عبر سمسا');
  assert.ok(score >= 3, `expected >=3 got ${score}`);
});

test('scorePolicy is ~0 for unrelated question', () => {
  const score = scorePolicy('عندكم عطر ورد؟', 'الإرجاع', 'الإرجاع متاح خلال 7 أيام');
  assert.equal(score, 0);
});
```

- [ ] **Step 2: شغّل الاختبار للتأكد من فشله**

Run: `node --test tests/knowledge-retrieval.test.js`
Expected: FAIL — `Cannot find module '../src/services/ai/knowledge-retrieval'`.

- [ ] **Step 3: نفّذ النواة**

أنشئ `src/services/ai/knowledge-retrieval.js`:
```js
'use strict';

const { normalizeArabic } = require('../../../lib/post-process-reply');

// كلمات وقف عربية شائعة لا تفيد في المطابقة
const STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','مع','هل','كم','ما','ماذا','وش','ايش','هذا','هذه',
  'ال','او','أو','و','يا','اي','أي','كل','عندكم','عندك','فيه','في','به','لو','لي','لك',
]);

// مجموعات مرادفات متناظرة (بعد التطبيع)
const SYN_GROUPS = [
  ['شحن','توصيل','توصل','يوصل','يوصلني','شحنه','ديليفري','يجي'],
  ['دفع','كاش','نقد','نقدا','فيزا','مدي','ادفع','تحويل','سداد'],
  ['ارجاع','استرجاع','ارجع','استبدال','تبديل','يرجع','ترجعون','بدل','رد'],
  ['حجز','احجز','طاوله','موعد','احجزون','احجزلي'],
  ['ضمان','كفاله','يضمن'],
  ['تغليف','هديه','كرت','بطاقه','يغلف','تغلفون'],
  ['مخزون','ستوك','متوفر','موجود','متاح'],
  ['مواقف','موقف','باركنج'],
];

const TOKEN_TO_GROUP = new Map();
SYN_GROUPS.forEach((group, idx) => {
  group.forEach(tok => {
    if (!TOKEN_TO_GROUP.has(tok)) TOKEN_TO_GROUP.set(tok, new Set());
    TOKEN_TO_GROUP.get(tok).add(idx);
  });
});

function tokenize(text) {
  return normalizeArabic(String(text || ''))
    .toLowerCase()
    .split(/[^a-z؀-ۿ]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function expandWithSynonyms(tokens) {
  const out = new Set(tokens);
  for (const tok of tokens) {
    const groups = TOKEN_TO_GROUP.get(tok);
    if (!groups) continue;
    for (const gi of groups) {
      for (const syn of SYN_GROUPS[gi]) out.add(syn);
    }
  }
  return out;
}

// الدرجة: تطابق مع المفتاح يساوي 3 نقاط لكل توكن، ومع نص الرد نقطة واحدة.
function scorePolicy(customerText, keyword, reply) {
  const customer = expandWithSynonyms(tokenize(customerText));
  const kwTokens = tokenize(keyword);
  const replyTokens = tokenize(reply);
  let score = 0;
  for (const kt of kwTokens) if (customer.has(kt)) score += 3;
  for (const rt of new Set(replyTokens)) if (customer.has(rt) && !kwTokens.includes(rt)) score += 1;
  return score;
}

module.exports = { tokenize, scorePolicy, expandWithSynonyms };
```

- [ ] **Step 4: شغّل الاختبار للتأكد من النجاح**

Run: `node --test tests/knowledge-retrieval.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/knowledge-retrieval.js tests/knowledge-retrieval.test.js
git commit -m "feat(ai): knowledge-retrieval scoring core with arabic synonyms"
```

---

## Task 3: `retrieveRelevantPolicies` — الاختيار وبناء الكتلة المُقيَّدة

**Files:**
- Modify: `src/services/ai/knowledge-retrieval.js`
- Test: `tests/knowledge-retrieval.test.js`

- [ ] **Step 1: أضف الاختبار الفاشل**

أضف إلى `tests/knowledge-retrieval.test.js`:
```js
const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');

const POLICIES = {
  'الشحن': 'الشحن مجاني فوق 200 ريال ويوصل خلال 2-4 أيام عبر سمسا',
  'الدفع': 'نوفر الدفع عند الاستلام ومدى وآبل باي',
  'الإرجاع': 'الإرجاع متاح خلال 7 أيام بشرط أن المنتج لم يُفتح',
};

test('retrieve injects matched policy block with constraint warning', () => {
  const { block, matched } = retrieveRelevantPolicies(
    { autoReplyKeywords: POLICIES }, 'متى يوصلني الطلب؟');
  assert.match(block, /سياسات_المتجر_الجاهزة/);
  assert.match(block, /سمسا/);                       // الرد المطابق محقون
  assert.match(block, /مواصفات.*المنتجات.*عدم الاختراع/s); // تحذير ث1
  assert.ok(matched.some(m => m.keyword === 'الشحن'));
});

test('retrieve returns empty block when no policies', () => {
  const { block, matched } = retrieveRelevantPolicies({ autoReplyKeywords: {} }, 'مرحبا');
  assert.equal(block, '');
  assert.equal(matched.length, 0);
});

test('retrieve includes all policies when small set and nothing matched', () => {
  const { block } = retrieveRelevantPolicies({ autoReplyKeywords: POLICIES }, 'كلمة غير متعلقة xyz');
  // المجموعة صغيرة (<=8) → احقن الكل كأمان
  assert.match(block, /سمسا/);
  assert.match(block, /آبل باي/);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/knowledge-retrieval.test.js`
Expected: FAIL — `retrieveRelevantPolicies is not a function`.

- [ ] **Step 3: نفّذ الدالة**

أضف إلى `src/services/ai/knowledge-retrieval.js` (قبل `module.exports`):
```js
const MAX_INJECTED = 6;     // سقف الكتلة
const SCORE_THRESHOLD = 3;  // أقل درجة تعتبر "مطابقة"
const SMALL_SET = 8;        // أقل من هذا: احقن الكل عند عدم وجود مطابقة
const LARGE_SET = 20;       // أكثر من هذا: احقن المطابقات فقط

const CONSTRAINT = 'مهم: هذه سياسات عامة فقط (شحن/دفع/إرجاع/حجز/أوقات/رسوم). مواصفات المنتجات وتوافقها وأي ميزة تقنية تبقى خاضعة لقاعدة عدم الاختراع — لا تجزم بميزة غير مذكورة صراحة في قائمة المنتجات.';

function buildBlock(replies) {
  if (!replies.length) return '';
  const lines = replies.map(r => `- ${r}`).join('\n');
  return `\n\n<سياسات_المتجر_الجاهزة>\nهذه سياسات عامة كتبها صاحب المتجر. إن خصّ سؤال العميل أياً منها، اعتمدها كمصدر حقيقة وصُغها بأسلوبك القصير، ولا تقل "بسأل المختص" لمعلومة موجودة هنا.\n${CONSTRAINT}\n${lines}\n</سياسات_المتجر_الجاهزة>`;
}

function retrieveRelevantPolicies(config = {}, customerText = '') {
  const entries = Object.entries(config.autoReplyKeywords || {})
    .map(([keyword, reply]) => ({ keyword: String(keyword || '').trim(), reply: String(reply || '').trim() }))
    .filter(e => e.keyword && e.reply);

  if (!entries.length) return { block: '', matched: [] };

  const scored = entries
    .map(e => ({ ...e, score: scorePolicy(customerText, e.keyword, e.reply) }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(e => e.score >= SCORE_THRESHOLD);

  let selected;
  if (matched.length) {
    selected = matched.slice(0, MAX_INJECTED);
  } else if (entries.length <= SMALL_SET) {
    selected = entries;                 // مجموعة صغيرة: احقن الكل (آمن ورخيص)
  } else if (entries.length <= LARGE_SET) {
    selected = scored.slice(0, MAX_INJECTED); // متوسطة: أعلى درجات
  } else {
    selected = [];                      // كبيرة جداً بلا مطابقة: لا تحقن (تشويش/تكلفة)
  }

  return {
    block: buildBlock(selected.map(e => e.reply)),
    matched: matched.map(e => ({ keyword: e.keyword, reply: e.reply, score: e.score })),
  };
}
```
وعدّل التصدير:
```js
module.exports = { tokenize, scorePolicy, expandWithSynonyms, retrieveRelevantPolicies };
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/knowledge-retrieval.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/knowledge-retrieval.js tests/knowledge-retrieval.test.js
git commit -m "feat(ai): retrieveRelevantPolicies with capped, constrained block"
```

---

## Task 4: دمج كتلة السياسات في `buildSystemPrompt` (المسارين، خلف flag)

**Files:**
- Modify: `lib/ai-client.js:102-198`
- Test: `tests/ai-client-knowledge-injection.test.js`

- [ ] **Step 1: اكتب الاختبار الفاشل**

أنشئ `tests/ai-client-knowledge-injection.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

function client(extra) {
  return new AIClient({ ...DEFAULT_CONFIG, ...extra },
    { info(){}, warn(){}, error(){} }, { record(){} });
}
const POLICIES = { 'الشحن': 'الشحن عبر سمسا خلال 2-4 أيام' };

test('default-path prompt injects policy block', () => {
  const ai = client({ storeName: 'متجر', autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /سياسات_المتجر_الجاهزة/);
  assert.match(p, /سمسا/);
});

test('long-instructions path also injects policy block', () => {
  const ai = client({ botInstructions: 'تعليمات طويلة '.repeat(20), autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /سياسات_المتجر_الجاهزة/);
});

test('flag KNOWLEDGE_INJECTION_ENABLED=false disables injection', () => {
  process.env.KNOWLEDGE_INJECTION_ENABLED = 'false';
  const ai = client({ storeName: 'متجر', autoReplyKeywords: POLICIES });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.doesNotMatch(p, /سياسات_المتجر_الجاهزة/);
  delete process.env.KNOWLEDGE_INJECTION_ENABLED;
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/ai-client-knowledge-injection.test.js`
Expected: FAIL (لا يوجد `سياسات_المتجر_الجاهزة` في البرومنت).

- [ ] **Step 3: نفّذ الدمج**

في `lib/ai-client.js`، أضف بعد سطر `require` للـpost-process (قرب السطر 21):
```js
const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');
```
داخل `buildSystemPrompt`، بعد سطر `const productContext = ...` (السطر 109)، أضف:
```js
    const knowledgeEnabled = process.env.KNOWLEDGE_INJECTION_ENABLED !== 'false';
    const policyBlock = knowledgeEnabled
      ? retrieveRelevantPolicies(this.config, lastUserText).block
      : '';
```
ثم في return الخاص بالتعليمات الطويلة (السطر ~188) أضف `${policyBlock}` بعد `${platformBlock}`:
```js
      return `${customInstructions}${knowledgeRules}${platformBlock}${policyBlock}${profileBlock}${escalationBlock}${welcomeHint}`;
```
وفي return الافتراضي (السطر ~197) أضف `${policyBlock}` بعد `${platformBlock}${knowledgeRules}`:
```js
${platformBlock}${knowledgeRules}${policyBlock}${profileBlock}${escalationBlock}${welcomeHint}`;
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/ai-client-knowledge-injection.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: شغّل كل اختبارات البرومنت القديمة (عدم انحدار)**

Run: `node --test tests/ai-prompt-rules.test.js tests/ai-client-prompt.test.js`
Expected: PASS (لا كسر للسلوك القديم).

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-client-knowledge-injection.test.js
git commit -m "feat(ai): inject store-policy knowledge block into system prompt (flagged)"
```

---

## Task 5: Validator — فرض الطول (حتمي، آمن)

**Files:**
- Create: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: اكتب الاختبار الفاشل**

أنشئ `tests/reply-validator.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceLength } = require('../src/services/ai/reply-validator');

test('enforceLength keeps short replies untouched', () => {
  assert.equal(enforceLength('رد قصير', 300), 'رد قصير');
});

test('enforceLength truncates at sentence boundary when over limit', () => {
  const long = 'الجملة الأولى مفيدة. الجملة الثانية زائدة جداً وتتجاوز الحد المسموح به كثيراً جداً.';
  const out = enforceLength(long, 30);
  assert.ok(out.length <= 32, `len=${out.length}`);
  assert.ok(out.startsWith('الجملة الأولى'));
});

test('enforceLength hard-cuts when no sentence boundary', () => {
  const out = enforceLength('كلمةطويلةجدا'.repeat(20), 30);
  assert.ok(out.length <= 31);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: نفّذ**

أنشئ `src/services/ai/reply-validator.js`:
```js
'use strict';

// قصّ الرد على حدّ الطول، مفضّلاً نهاية جملة كاملة قبل الحدّ.
function enforceLength(reply, maxLen) {
  const text = String(reply || '').trim();
  const limit = Math.max(40, parseInt(maxLen, 10) || 300);
  if (text.length <= limit) return text;

  const slice = text.slice(0, limit + 1);
  // ابحث عن آخر فاصل جملة ضمن الحد
  const lastBoundary = Math.max(
    slice.lastIndexOf('.'), slice.lastIndexOf('!'),
    slice.lastIndexOf('؟'), slice.lastIndexOf('\n'),
  );
  if (lastBoundary >= 20) return text.slice(0, lastBoundary + 1).trim();
  return text.slice(0, limit).trim();
}

module.exports = { enforceLength };
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): reply-validator enforceLength (deterministic)"
```

---

## Task 6: Validator — ضمان علامة التصعيد (حتمي، يغلق ث2)

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: أضف الاختبار الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
const { enforceEscalationTag, detectEscalationIntent } = require('../src/services/ai/reply-validator');

const ESC_CONFIG = { escalationContacts: [{ name: 'المالك', phone: '0500000000' }] };

test('detectEscalationIntent true for explicit human request', () => {
  assert.equal(detectEscalationIntent('أبي أكلم المدير'), true);
  assert.equal(detectEscalationIntent('ودي أتواصل مع موظف'), true);
});
test('detectEscalationIntent false for normal question', () => {
  assert.equal(detectEscalationIntent('وش عندكم قهوة؟'), false);
});
test('enforceEscalationTag appends tag when intent present but tag missing', () => {
  const out = enforceEscalationTag('تمام بسجل طلبك ويتواصل معك المختص.', ESC_CONFIG, 'أبي أكلم المدير');
  assert.match(out, /\[تحويل:/);
});
test('enforceEscalationTag does nothing when tag already present', () => {
  const r = 'تمام. [تحويل:المالك|طلب تواصل]';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'أبي أكلم المدير'), r);
});
test('enforceEscalationTag does nothing when no intent', () => {
  const r = 'القهوة متوفرة عندنا.';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'وش عندكم قهوة؟'), r);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — `detectEscalationIntent is not a function`.

- [ ] **Step 3: نفّذ**

أضف إلى `src/services/ai/reply-validator.js`:
```js
const WANT = /(يبي|يبغى|أبي|ابي|ودي|أبغى|ابغى|أحتاج|احتاج|ممكن أكلم|اكلم|اتواصل)/;
const HUMAN = /(موظف|مختص|مسؤول|مسئول|إنسان|انسان|بشر|المدير|المالك|صاحب المحل|احد)/;

function detectEscalationIntent(customerText) {
  const t = String(customerText || '');
  return WANT.test(t) && HUMAN.test(t);
}

function enforceEscalationTag(reply, config = {}, customerText = '') {
  const text = String(reply || '');
  if (/\[تحويل:/.test(text)) return text;            // النموذج وضعها
  if (!detectEscalationIntent(customerText)) return text;
  const contacts = config.escalationContacts || [];
  if (!contacts.length) return text;                 // لا جهة تصعيد مضبوطة
  const name = contacts[0].name || 'المالك';
  const summary = String(customerText || '').slice(0, 40).replace(/[|\]]/g, ' ').trim();
  return `${text.trim()} [تحويل:${name}|${summary}]`;
}

module.exports = { enforceLength, detectEscalationIntent, enforceEscalationTag };
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): deterministic escalation-tag guarantee"
```

---

## Task 7: Validator — كاشف التهرّب (cop-out) عند توفّر سياسة مطابقة

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: أضف الاختبار الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
const { isCopOut, needsRepairForCopOut } = require('../src/services/ai/reply-validator');

test('isCopOut detects deflection phrases', () => {
  assert.equal(isCopOut('ودّي أأكد لك المعلومة من المختص، تسمح لي؟'), true);
  assert.equal(isCopOut('الشحن خلال 2-4 أيام عبر سمسا'), false);
});
test('needsRepairForCopOut true when deflecting despite a matched policy', () => {
  const matched = [{ keyword: 'الشحن', reply: 'الشحن عبر سمسا خلال 2-4 أيام', score: 3 }];
  assert.equal(needsRepairForCopOut('أأكد لك من المختص، تسمح لي؟', matched), true);
});
test('needsRepairForCopOut false when no matched policy (legit deflection)', () => {
  assert.equal(needsRepairForCopOut('أأكد لك من المختص، تسمح لي؟', []), false);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — `isCopOut is not a function`.

- [ ] **Step 3: نفّذ**

أضف إلى `src/services/ai/reply-validator.js`:
```js
const COPOUT = /(أأكد لك|اأكد لك|أتأكد لك|اتأكد لك|بسأل المختص|اسأل المختص|بسأل المسؤول|أرجع لك بأقرب|تسمح لي|من المختص)/;

function isCopOut(reply) {
  return COPOUT.test(String(reply || ''));
}

// تهرّب رغم وجود سياسة مطابقة بدرجة عالية = يحتاج إصلاح (إعادة توليد بحقن الجواب)
function needsRepairForCopOut(reply, matched = []) {
  return isCopOut(reply) && Array.isArray(matched) && matched.some(m => m.score >= 3);
}

module.exports = { enforceLength, detectEscalationIntent, enforceEscalationTag, isCopOut, needsRepairForCopOut };
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): cop-out detector tied to matched policy"
```

---

## Task 8: المنسّق `validateAndRepair` (إصلاح واحد ثم fallback آمن)

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: أضف الاختبار الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
const { validateAndRepair } = require('../src/services/ai/reply-validator');

test('validateAndRepair applies deterministic fixes without regenerate', async () => {
  const out = await validateAndRepair({
    reply: 'تمام بسجل طلبك.',
    config: ESC_CONFIG, customerText: 'أبي أكلم المدير', matched: [],
    regenerate: async () => { throw new Error('should not be called'); },
  });
  assert.match(out, /\[تحويل:/);          // أُضيفت العلامة حتمياً
});

test('validateAndRepair regenerates once on cop-out then keeps better reply', async () => {
  const matched = [{ keyword: 'الشحن', reply: 'الشحن عبر سمسا خلال 2-4 أيام', score: 3 }];
  let calls = 0;
  const out = await validateAndRepair({
    reply: 'أأكد لك من المختص، تسمح لي؟',
    config: {}, customerText: 'متى يوصلني؟', matched,
    regenerate: async () => { calls++; return 'الشحن عبر سمسا خلال 2-4 أيام عمل'; },
  });
  assert.equal(calls, 1);
  assert.match(out, /سمسا/);
});

test('validateAndRepair returns original when regenerate also bad (no infinite loop)', async () => {
  const matched = [{ keyword: 'الشحن', reply: 'x', score: 3 }];
  let calls = 0;
  const out = await validateAndRepair({
    reply: 'أأكد لك من المختص، تسمح لي؟',
    config: {}, customerText: 'متى يوصلني؟', matched,
    regenerate: async () => { calls++; return 'أأكد لك من المختص مرة ثانية، تسمح لي؟'; },
  });
  assert.equal(calls, 1);                  // مرة واحدة فقط
  assert.ok(typeof out === 'string' && out.length > 0);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — `validateAndRepair is not a function`.

- [ ] **Step 3: نفّذ**

أضف إلى `src/services/ai/reply-validator.js` (قبل `module.exports`، وحدّث التصدير):
```js
// المنسّق: إصلاحات حتمية أولاً، ثم إعادة توليد واحدة عند تهرّب رغم سياسة مطابقة.
async function validateAndRepair({ reply, config = {}, customerText = '', matched = [], regenerate } = {}) {
  let current = String(reply || '').trim();
  const maxLen = config.maxResponseLength;

  // 1) إعادة توليد واحدة عند التهرّب رغم سياسة مطابقة
  if (needsRepairForCopOut(current, matched) && typeof regenerate === 'function') {
    try {
      const repaired = String(await regenerate() || '').trim();
      if (repaired && !isCopOut(repaired)) current = repaired;  // اقبل الأفضل فقط
    } catch { /* أبقِ الأصل */ }
  }

  // 2) إصلاحات حتمية (لا تحتاج نموذجاً)
  current = enforceEscalationTag(current, config, customerText);
  current = enforceLength(current, maxLen);
  return current;
}

module.exports = {
  enforceLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair,
};
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): validateAndRepair orchestrator (single repair + safe fallback)"
```

---

## Task 9: دمج `validateAndRepair` في `getReply` (خلف flag)

**Files:**
- Modify: `lib/ai-client.js:201-276`
- Test: `tests/ai-client-knowledge-injection.test.js`

- [ ] **Step 1: اكتب اختبار الدمج الفاشل**

أضف إلى `tests/ai-client-knowledge-injection.test.js`:
```js
test('getReply applies deterministic escalation tag via validator', async () => {
  const ai = client({
    storeName: 'متجر',
    escalationContacts: [{ name: 'المالك', phone: '0500000000' }],
  });
  // بدّل buildClient لإرجاع رد ثابت بدون شبكة
  ai.buildClient = () => ({
    model: 'test-model',
    openai: { chat: { completions: { create: async () => ({
      choices: [{ message: { content: 'تمام بسجل طلبك.' } }], usage: {},
    }) } } },
  });
  const out = await ai.getReply([{ role: 'user', content: 'أبي أكلم المدير' }], { isFirstMsg: true });
  assert.match(out, /\[تحويل:/);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/ai-client-knowledge-injection.test.js`
Expected: FAIL (لا توجد علامة `[تحويل:` لأن الـvalidator غير مدموج).

- [ ] **Step 3: نفّذ الدمج**

في `lib/ai-client.js` أضف require قرب الأعلى (بعد require الاسترجاع):
```js
const { validateAndRepair } = require('../src/services/ai/reply-validator');
```
في `getReply`، بعد سطر `const system = this.buildSystemPrompt(history, opts);` (السطر 203) احفظ آخر نص للعميل والسياسات المطابقة:
```js
    const lastUserText = opts.latestUserText || [...history].reverse().find(m => m.role === 'user')?.content || '';
    const validatorEnabled = process.env.REPLY_VALIDATOR_ENABLED !== 'false';
    const { matched: matchedPolicies } = validatorEnabled
      ? require('../src/services/ai/knowledge-retrieval').retrieveRelevantPolicies(this.config, lastUserText)
      : { matched: [] };
```
ثم استبدل السطر 266:
```js
        const reply = stripAvoidedContent(rawReply, this.config);
```
بـ:
```js
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
```

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/ai-client-knowledge-injection.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: شغّل كامل الحزمة (عدم انحدار)**

Run: `node --test`
Expected: PASS — لا فشل جديد في أي اختبار قائم.

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-client-knowledge-injection.test.js
git commit -m "feat(ai): wire validateAndRepair into getReply (flagged)"
```

---

## Task 10: حواجز الانحدار + توثيق الـflags

**Files:**
- Modify: `tests/ai-client-knowledge-injection.test.js`
- Modify: `.env.example`

- [ ] **Step 1: اختبار انحدار لثغرة ث1 (الكتلة لا تشجّع اختراع الميزات)**

أضف إلى `tests/ai-client-knowledge-injection.test.js`:
```js
test('policy block carries explicit no-invention warning for product specs (ث1 guard)', () => {
  const ai = client({ storeName: 'متجر', autoReplyKeywords: { 'الشحن': 'سمسا 2-4 أيام' } });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'متى يوصلني؟' }], {});
  assert.match(p, /مواصفات المنتجات وتوافقها.*عدم الاختراع/s);
});
```

- [ ] **Step 2: شغّل**

Run: `node --test tests/ai-client-knowledge-injection.test.js`
Expected: PASS.

- [ ] **Step 3: وثّق الـflags في `.env.example`**

أضف هذه الأسطر إلى `.env.example`:
```
# عقل البوت (Phase 1) — اضبط على false لإيقاف الطبقة فوراً عند أي مشكلة
KNOWLEDGE_INJECTION_ENABLED=true
REPLY_VALIDATOR_ENABLED=true
```

- [ ] **Step 4: Commit**

```bash
git add tests/ai-client-knowledge-injection.test.js .env.example
git commit -m "test+docs: ث1 regression guard + feature-flag docs"
```

---

## Task 11: تقييم online اختياري (خارج CI)

**Files:**
- Create: `scripts/eval/bot-brain-eval.js`

- [ ] **Step 1: أنشئ harness التقييم**

أنشئ `scripts/eval/bot-brain-eval.js` يعيد سيناريوهات التحقق الثلاثة (عطور/إلكترونيات/كافيه)، يبني config لكل مجال، يستدعي `ai.getReply` على نموذج حقيقي (المفتاح من `process.env.EVAL_API_KEY`)، ويطبع نِسَب النجاح مقابل العتبات في الـspec §2. لا يُستورد في أي اختبار CI.

```js
'use strict';
// تشغيل يدوي فقط: EVAL_API_KEY=... node scripts/eval/bot-brain-eval.js
// يقيس: الردود الآلية (هدف ≥95%)، عدم اختراع السعر (100%)، التزام الطول (100%).
// (محتوى السيناريوهات يُكتب هنا بناءً على §7 من الـspec.)
if (!process.env.EVAL_API_KEY) { console.error('set EVAL_API_KEY'); process.exit(1); }
// ... سيناريوهات + استدعاء AIClient + طباعة نِسَب ...
console.log('eval harness — fill scenarios per spec §7');
```

- [ ] **Step 2: Commit**

```bash
git add scripts/eval/bot-brain-eval.js
git commit -m "chore(eval): offline-from-CI online eval harness skeleton"
```

---

## Self-Review (مكتمل)

- **تغطية الـspec:** L1 (Tasks 2-4)، L2 الأقسام الـXML مؤجَّلة؟ — **ملاحظة:** هذه الخطة تنفّذ L1 (الحقن) + L4 (Validator) وهما اللذان أثبت التحقق أنهما يحلان شكوى المستخدم. إعادة هيكلة L2 إلى XML الكامل **مؤجَّلة لخطة منفصلة** (تحسين تدريجي، غير حرجة للإطلاق) — الكتلة المحقونة تستخدم وسوم `<سياسات_المتجر_الجاهزة>` بالفعل. التصعيد/الطول/الاختراع مغطّاة في Tasks 5-10.
- **Placeholder scan:** لا توجد TODO في الأكواد التنفيذية (Task 11 هيكل تقييم يدوي مُعلَّم صراحةً).
- **اتساق الأنواع:** `retrieveRelevantPolicies` ترجع `{block, matched}` وتُستخدم كذلك في Tasks 4 و9. `matched[i]` = `{keyword, reply, score}` ويُقرأ `.score` في Task 7/8. أسماء الدوال متطابقة عبر المهام.

> **حدود مقصودة (YAGNI):** فحص "اكتمال السؤال المركّب" و"اختراع السعر الرقمي" مذكوران في الـspec لكن أُجِّلا عن هذه الخطة لأنهما الأعلى خطراً في إنتاج false-positives تُفسد ردوداً سليمة (يخالف شرط المستخدم "ما يصير مشاكل جديدة"). يُضافان في خطة لاحقة بعد قياس Phase 1 على الإنتاج. الإصلاحات الحتمية المضمّنة (تصعيد + طول + تهرّب) آمنة ومنخفضة المخاطر.
