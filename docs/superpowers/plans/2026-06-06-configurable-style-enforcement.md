# Configurable Per-Merchant Style Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** كل تاجر يختار ضوابط أسلوبه من الداشبورد (إيموجي/تعجب/نقطة/عبارات ممنوعة)، وفلتر حتمي يفرضها على رد الذكاء — بدون أي كود خاص بمتجر، والافتراضات تحافظ على سلوك التجار الحاليين.

**Architecture:** دالة نقية `enforceStyleRules(reply, config)` في `reply-validator.js` تقرأ `config.replyStyle` وتطبّق فقط ما اختاره التاجر؛ تُدمج في `validateAndRepair`؛ والداشبورد يضيف مفتاحَي تبديل (تعجب/نقطة) — الإيموجي والعبارات الممنوعة موجودة أصلاً.

**Tech Stack:** Node.js v24، `node:test`. الداشبورد `dashboard/index.html` (vanilla JS). تشغيل: `node --test`.

**مبدأ الأمان (multi-tenant):** كل ضابط افتراضه "مسموح" (`allowExclamation`/`allowSentencePeriods` غير معرّفين → لا حذف؛ `emojiLevel` الافتراضي 'medium' → لا حذف). فالتاجر الحالي ما يتأثر إلا إذا اختار المنع صراحةً.

---

## File Structure

| ملف | مسؤولية | تعديل |
|---|---|---|
| `src/services/ai/reply-validator.js` | `enforceStyleRules` + دمجها في `validateAndRepair` | تعديل |
| `tests/reply-validator.test.js` | اختبارات الفلتر | تعديل |
| `dashboard/index.html` | مفتاحا "السماح بعلامات التعجب" و"السماح بالنقطة" + load/save | تعديل |
| `scripts/eval/data-style-eval.js` | إثبات قبل/بعد على برومنت حقيقي | تعديل (إضافة سيناريو) |

الموجود مسبقاً (لا نكرره): `emojiLevel` (select `rsEmoji`)، العبارات الممنوعة (`avoidPhrasesChips` → `replyStyle.avoidPhrases`، تُمسح عبر `stripAvoidedContent`).

---

## Task 1: `enforceStyleRules` — فلتر أسلوب حتمي config-driven

**Files:**
- Modify: `src/services/ai/reply-validator.js`
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: اكتب الاختبارات الفاشلة**

أضف إلى `tests/reply-validator.test.js`:
```js
const { enforceStyleRules } = require('../src/services/ai/reply-validator');

test('enforceStyleRules: strips emoji only when emojiLevel none', () => {
  assert.equal(enforceStyleRules('أهلين 🌟😊', { replyStyle: { emojiLevel: 'none' } }), 'أهلين');
  assert.equal(enforceStyleRules('أهلين 🌟', { replyStyle: { emojiLevel: 'medium' } }), 'أهلين 🌟');
});
test('enforceStyleRules: strips "!" only when allowExclamation false', () => {
  assert.equal(enforceStyleRules('حياك الله!', { replyStyle: { allowExclamation: false } }), 'حياك الله');
  assert.equal(enforceStyleRules('حياك الله!', { replyStyle: {} }), 'حياك الله!');
});
test('enforceStyleRules: strips sentence-ending periods when allowSentencePeriods false', () => {
  const cfg = { replyStyle: { allowSentencePeriods: false } };
  assert.equal(enforceStyleRules('السعر 59 ريال. التسليم دعوة.', cfg), 'السعر 59 ريال التسليم دعوة');
  // لا يمسّ النقطة العشرية ولا الروابط
  assert.equal(enforceStyleRules('النسخة 3.5 على prostoree.com', cfg), 'النسخة 3.5 على prostoree.com');
});
test('enforceStyleRules: defaults preserve everything (no merchant choice = no change)', () => {
  const r = 'مرحبا! السعر 59 ريال. 🌟';
  assert.equal(enforceStyleRules(r, { replyStyle: {} }), r);
  assert.equal(enforceStyleRules(r, {}), r);
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — `enforceStyleRules is not a function`.

- [ ] **Step 3: نفّذ**

أضف إلى `src/services/ai/reply-validator.js` (وحدّث module.exports):
```js
// نطاق إيموجي واسع (رموز + متغيرات + أعلام + ZWJ)
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu;

// يفرض ضوابط أسلوب التاجر المختارة فقط (config-driven، آمن متعدد المستأجرين).
function enforceStyleRules(reply, config = {}) {
  const r = (config && config.replyStyle) || {};
  let out = String(reply || '');
  if (r.emojiLevel === 'none') out = out.replace(EMOJI_RE, '');
  if (r.allowExclamation === false) out = out.replace(/[!！]/g, '');
  if (r.allowSentencePeriods === false) {
    // احذف النقطة المنهية لجملة (مسبوقة بحرف غير رقمي، يتبعها مسافة/سطر/نهاية)،
    // دون المساس بالنقطة العشرية (3.5) أو داخل الروابط (.com).
    out = out.replace(/([^\d\s])\.(?=\s|$)/g, '$1');
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([،؟])/g, '$1').trim();
  return out;
}

module.exports = {
  enforceLength, detectEscalationIntent, enforceEscalationTag,
  isCopOut, needsRepairForCopOut, validateAndRepair, stripStyleViolations,
  enforceStyleRules,
};
```
> تأكد أن `module.exports` النهائي يضم كل الدوال السابقة + `enforceStyleRules`.

- [ ] **Step 4: شغّل للتأكد من النجاح**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): config-driven enforceStyleRules (emoji/exclamation/period)"
```

---

## Task 2: دمج `enforceStyleRules` في `validateAndRepair`

**Files:**
- Modify: `src/services/ai/reply-validator.js` (داخل `validateAndRepair`)
- Test: `tests/reply-validator.test.js`

- [ ] **Step 1: اكتب اختبار الدمج الفاشل**

أضف إلى `tests/reply-validator.test.js`:
```js
test('validateAndRepair enforces merchant style choices', async () => {
  const out = await validateAndRepair({
    reply: 'حياك الله! السعر 59 ريال. 🌟',
    config: { replyStyle: { emojiLevel: 'none', allowExclamation: false, allowSentencePeriods: false } },
    customerText: 'كم السعر', matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.equal(/[!🌟]/.test(out), false, 'لا تعجب ولا إيموجي');
  assert.equal(/ريال\./.test(out), false, 'لا نقطة بعد ريال');
  assert.ok(out.includes('59 ريال'));
});
```

- [ ] **Step 2: شغّل للتأكد من الفشل**

Run: `node --test tests/reply-validator.test.js`
Expected: FAIL — التعجب/الإيموجي/النقطة باقية.

- [ ] **Step 3: نفّذ الدمج**

في `validateAndRepair` (داخل `src/services/ai/reply-validator.js`)، بعد سطر `current = stripStyleViolations(current);` أضف:
```js
  current = enforceStyleRules(current, config);
```
(الترتيب: cop-out repair → stripStyleViolations → enforceStyleRules → فصل علامة التصعيد → enforceLength → إعادة العلامة.)

- [ ] **Step 4: شغّل للتأكد من النجاح + عدم الانحدار**

Run: `node --test tests/reply-validator.test.js`
Expected: PASS (الكل، بما فيه الـ38 القائمة).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator.test.js
git commit -m "feat(ai): wire enforceStyleRules into validateAndRepair"
```

---

## Task 3: مفاتيح الداشبورد (تعجب/نقطة) + load/save

**Files:**
- Modify: `dashboard/index.html` (HTML قرب `rsEmoji` + load السطر ~1837 + save السطر ~2393)

- [ ] **Step 1: أضف عنصري التبديل في الـHTML**

ابحث في `dashboard/index.html` عن عنصر `<select id="rsEmoji">` (حقل مستوى الإيموجي). **بعد** مجموعة الحقل التي تحويه مباشرةً، أضف:
```html
<div class="form-group">
  <label><input type="checkbox" id="rsAllowExclamation" checked> السماح بعلامات التعجب (!)</label>
  <label style="margin-right:16px"><input type="checkbox" id="rsAllowPeriods" checked> السماح بالنقطة في نهاية الجمل</label>
  <small style="display:block;color:#888">ألغِ الاختيار لمنعها نهائياً في كل ردود البوت.</small>
</div>
```

- [ ] **Step 2: حمّل القيم عند فتح الإعدادات**

في دالة التحميل، بعد السطر `document.getElementById('rsEmoji').value=r.emojiLevel||'medium';` (≈1837) أضف:
```js
  document.getElementById('rsAllowExclamation').checked = r.allowExclamation !== false;
  document.getElementById('rsAllowPeriods').checked = r.allowSentencePeriods !== false;
```

- [ ] **Step 3: احفظ القيم ضمن replyStyle**

في كائن `replyStyle` عند الحفظ (≈2393، بعد `emojiLevel:...`) أضف:
```js
    allowExclamation:document.getElementById('rsAllowExclamation').checked,
    allowSentencePeriods:document.getElementById('rsAllowPeriods').checked,
```

- [ ] **Step 4: تحقق يدوي من سلامة الصفحة**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('dashboard/index.html','utf8');['rsAllowExclamation','rsAllowPeriods'].forEach(id=>console.log(id, (h.match(new RegExp(id,'g'))||[]).length>=3?'OK (html+load+save)':'NAQIS'));"`
Expected: كلاهما OK (يظهر ≥3 مرات: HTML + load + save).

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): per-merchant toggles for exclamation + sentence periods"
```

---

## Task 4: إثبات قبل/بعد على برومنت حقيقي + الحزمة الكاملة

**Files:**
- Modify: `scripts/eval/data-style-eval.js`

- [ ] **Step 1: أضف سيناريو الأسلوب الحتمي للـharness**

في `scripts/eval/data-style-eval.js`، أضف بعد التعريفات config إضافياً يفعّل الضوابط، ودالة تطبع المخالفات قبل/بعد على رسائل حقيقية. أضف هذا في نهاية الملف (قبل التشغيل أو كقسم مستقل):
```js
// ---- اختبار فرض الأسلوب الحتمي ----
const { validateAndRepair } = require(path.join(__dirname,'..','..','src','services','ai','reply-validator'));
const styleCfg = { replyStyle: { emojiLevel:'none', allowExclamation:false, allowSentencePeriods:false } };
const samples = ['حياك الله! معك محمد.', 'السعر 59 ريال. 🌟', 'تحت أمرك!'];
(async () => {
  console.log('\n===== فرض الأسلوب (config-driven) =====');
  for (const s of samples) {
    const after = await validateAndRepair({ reply:s, config:styleCfg, customerText:'', matched:[], regenerate:async()=>s });
    console.log('قبل: '+s+'  →  بعد: '+after);
  }
})();
```
> هذا الجزء لا يحتاج مفتاح API (يختبر الفلتر مباشرة). جزء gpt-4o القائم يبقى كما هو.

- [ ] **Step 2: شغّل الـharness (الجزء الحتمي بلا مفتاح)**

Run: `node scripts/eval/data-style-eval.js 2>/dev/null || node -e "require('./scripts/eval/data-style-eval.js')"`
> إن طلب مفتاحاً، شغّل فقط قسم الأسلوب يدوياً عبر node REPL. المتوقع: "حياك الله! معك محمد." → "حياك الله معك محمد" (بلا تعجب/نقطة).

- [ ] **Step 3: شغّل الحزمة الكاملة (عدم انحدار)**

Run: `node --test`
Expected: لا فشل جديد (عدا `runtime-bot-stability-fixes.test.js` البيئي).

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/data-style-eval.js
git commit -m "chore(eval): deterministic style-enforcement before/after samples"
```

---

## Self-Review

- **تغطية:** الضوابط الأربعة: إيموجي (Task 1، عبر emojiLevel القائم)، تعجب (Task 1+3)، نقطة (Task 1+3)، عبارات ممنوعة (موجودة أصلاً عبر avoidPhrases/stripAvoidedContent — لا عمل جديد). الفرض الحتمي (Task 2). اختيار التاجر (Task 3).
- **Placeholder scan:** لا TODO تنفيذي.
- **اتساق:** `enforceStyleRules` معرّفة Task 1، تُدمج Task 2؛ مفاتيح `allowExclamation`/`allowSentencePeriods` متطابقة بين الداشبورد (Task 3) والفلتر (Task 1).
- **أمان multi-tenant:** الافتراضات (`!== false` / `=== 'none'` / `=== false`) تضمن أن التاجر غير المُعدِّل لا يتأثر. ✓
- **مخاطر:** regex النقطة قد يحذف نقطة مقصودة في اختصار نادر — لكنه مشروط باختيار التاجر "منع النقطة"، فهو نيّته. emoji regex قد لا يغطي كل الرموز النادرة — مقبول (يغطي الشائع).
