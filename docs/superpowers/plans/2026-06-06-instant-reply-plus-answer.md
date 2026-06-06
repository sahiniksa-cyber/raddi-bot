# دمج الرد الفوري مع جواب الذكاء (Approach A) — خطة تنفيذ

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. خطوات بصيغة `- [ ]`.

**Goal:** رسالة فيها محفّز رد فوري + سؤال زائد → ترسل الرد الفوري حرفياً + جواب الذكاء على الباقي (تشمل أسئلة متعددة). المسار السريع (محفّز وحده) يبقى.

**Architecture:** دالة نقية `collectInstantReplies` تكشف المطابقات + وجود سؤال زائد؛ `ai-client.getReply` يقبل `opts.instantAnswered` (تعليمة: لا تكرر المُجاب)؛ `ai-worker` يلصق الرد الفوري حرفياً قبل جواب الذكاء. `findAutoReply` يبقى دون تغيير.

**Tech Stack:** Node v24، `node:test`. تشغيل: `node --test`.

---

## Task 1: `collectInstantReplies` (دالة نقية)

**Files:**
- Modify: `src/services/bot/platform-features.js`
- Test: `tests/platform-features.test.js`

- [ ] **Step 1: اختبار فاشل** — أضف إلى `tests/platform-features.test.js`:
```js
const { collectInstantReplies } = require('../src/services/bot/platform-features');
const G = { autoReplyKeywords: { 'السلام عليكم': 'وعليكم السلام، حياك الله', 'الشحن': 'الشحن مجاني فوق 200' } };

test('collect: bare trigger → no extra question', () => {
  const r = collectInstantReplies(G, 'السلام عليكم');
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].reply, 'وعليكم السلام، حياك الله');
  assert.equal(r.hasExtraQuestion, false);
});
test('collect: trigger + real question → hasExtraQuestion true', () => {
  const r = collectInstantReplies(G, 'السلام عليكم كم سعر ادوبي؟');
  assert.equal(r.hasExtraQuestion, true);
});
test('collect: trigger + tiny remainder → no extra question', () => {
  assert.equal(collectInstantReplies(G, 'السلام عليكم كيفك').hasExtraQuestion, false);
});
test('collect: no match → empty', () => {
  const r = collectInstantReplies(G, 'كلام عادي بدون محفز');
  assert.equal(r.matched.length, 0);
  assert.equal(r.hasExtraQuestion, false);
});
test('collect: multiple triggers captured', () => {
  const r = collectInstantReplies(G, 'السلام عليكم وش اخبار الشحن');
  assert.ok(r.matched.length >= 2);
});
```

- [ ] **Step 2: شغّل وتأكد من الفشل** — `node --test tests/platform-features.test.js` → FAIL (`collectInstantReplies is not a function`).

- [ ] **Step 3: نفّذ** — في `src/services/bot/platform-features.js` أضف (وحدّث module.exports بإضافة `collectInstantReplies`):
```js
function collectInstantReplies(config = {}, text = '') {
  const lower = String(text || '').toLowerCase().trim();
  const matched = [];
  if (!lower) return { matched, hasExtraQuestion: false };
  let remainder = lower;
  for (const [keyword, reply] of Object.entries(config.autoReplyKeywords || {})) {
    const k = String(keyword || '').trim().toLowerCase();
    const r = String(reply || '').trim();
    if (!k || !r) continue;
    if (!lower.includes(k)) continue;
    matched.push({ keyword: k, reply: r });
    remainder = remainder.split(k).join(' ');
  }
  remainder = remainder.replace(/\s+/g, ' ').trim();
  const meaningful = remainder
    ? remainder.split(/\s+/).filter(w => w.replace(/[^؀-ۿa-z0-9]/gi, '').length >= 2)
    : [];
  const hasExtraQuestion = matched.length > 0 && meaningful.length >= 2;
  return { matched, hasExtraQuestion };
}
```

- [ ] **Step 4: شغّل وتأكد من النجاح** — `node --test tests/platform-features.test.js` → PASS (شامل اختبارات findAutoReply القديمة بدون تغيير).

- [ ] **Step 5: Commit**
```bash
git add src/services/bot/platform-features.js tests/platform-features.test.js
git commit -m "feat(bot): collectInstantReplies — detect matches + extra question"
```

---

## Task 2: `getReply` يقبل `instantAnswered` (تعليمة عدم التكرار)

**Files:**
- Modify: `lib/ai-client.js` (`buildSystemPrompt`)
- Test: `tests/ai-client-knowledge-injection.test.js`

- [ ] **Step 1: اختبار فاشل** — أضف إلى `tests/ai-client-knowledge-injection.test.js`:
```js
test('buildSystemPrompt adds no-repeat instruction when instantAnswered provided', () => {
  const ai = client({ storeName: 'متجر' });
  const p = ai.buildSystemPrompt([{ role: 'user', content: 'بكم ادوبي؟' }], { instantAnswered: 'وعليكم السلام، حياك الله' });
  assert.match(p, /مُجاب عليه|أُجيب|سبق الرد/);
  assert.match(p, /وعليكم السلام، حياك الله/);
});
```

- [ ] **Step 2: شغّل وتأكد من الفشل** — `node --test tests/ai-client-knowledge-injection.test.js` → FAIL.

- [ ] **Step 3: نفّذ** — في `lib/ai-client.js` داخل `buildSystemPrompt`، بعد بناء `policyBlock` (قرب السطر 110)، أضف:
```js
    const instantAnswered = String(opts.instantAnswered || '').trim();
    const instantBlock = instantAnswered
      ? `\n\n<أجزاء_سبق_الرد_عليها>\nالأجزاء التالية من رسالة العميل مُجاب عليها مسبقاً وستُرسل قبل ردك حرفياً:\n${instantAnswered}\nجاوب فقط على باقي رسالة العميل (بما فيها أي أسئلة إضافية) بدون تكرار ما سبق. إذا لم يبقَ شيء غير مُجاب، اكتفِ بجملة قصيرة مناسبة أو لا تضف.\n</أجزاء_سبق_الرد_عليها>`
      : '';
```
ثم أضف `${instantBlock}` في **كلا** مساري الإرجاع، بعد `${policyBlock}` مباشرةً:
- مسار التعليمات الطويلة: `...${platformBlock}${policyBlock}${instantBlock}${profileBlock}...`
- المسار الافتراضي: `...${policyBlock}${instantBlock}${profileBlock}...`

- [ ] **Step 4: شغّل وتأكد من النجاح** — `node --test tests/ai-client-knowledge-injection.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/ai-client.js tests/ai-client-knowledge-injection.test.js
git commit -m "feat(ai): buildSystemPrompt honors opts.instantAnswered (no-repeat)"
```

---

## Task 3: تكامل ai-worker — دمج حرفي + جواب

**Files:**
- Modify: `src/workers/ai-worker.js:596-645`

- [ ] **Step 1: عدّل منطق الـ short-circuit** — استبدل السطور 596-610 الحالية بـ:
```js
    // Instant replies: when the message is ONLY a trigger (no extra question)
    // and it's a single message, send the canned reply directly (fast path).
    // When there's an extra question, prepend the canned reply verbatim and let
    // the AI answer the rest (combine mode).
    const { collectInstantReplies } = require('../services/bot/platform-features');
    const { matched: instantMatched, hasExtraQuestion } = collectInstantReplies(config, text);
    const cannedPrefix = instantMatched.map(m => m.reply).join('\n');

    if (instantMatched.length && !hasExtraQuestion && enrichedMessages.length <= 1) {
      return await sendInstantAutoReply({
        job, payload, conversation, userId,
        instantReply: cannedPrefix,
        enrichedMessages,
      });
    }
    const combinePrefix = instantMatched.length ? cannedPrefix : '';
```

- [ ] **Step 2: مرّر `instantAnswered` للذكاء** — عدّل سطر `getReply` (≈635):
```js
    const reply = String(await ai.getReply(history, { isFirstMsg: history.filter(m => m.role === 'assistant').length === 0, customerProfile, instantAnswered: combinePrefix }) || '').trim();
```

- [ ] **Step 3: الصق الرد الفوري حرفياً قبل الإرسال** — بعد سطر `let customerReply = escalation.customerReply.trim();` (≈644)، أضف:
```js
    if (combinePrefix) {
      const aiPart = customerReply && customerReply !== combinePrefix ? `\n${customerReply}` : '';
      customerReply = `${combinePrefix}${aiPart}`.trim();
    }
```
> ملاحظة: لو فشل الذكاء (throw) قبل هنا، الكود الحالي يرمي؛ لضمان وصول الرد الفوري على الأقل، لُفّ نداء `getReply` بـtry/catch: عند الفشل و`combinePrefix` غير فارغ، أرسل `combinePrefix` عبر `sendInstantAutoReply` بدل الرمي. (نفّذها إن أمكن دون تعقيد؛ وإلا اذكرها كقَيد.)

- [ ] **Step 4: شغّل اختبارات ai-worker القائمة (عدم انحدار)** — `node --test tests/ai-worker-store-assistant.test.js tests/ai-worker-quota.test.js tests/ai-worker-media-batching.test.js tests/ai-worker-failure.test.js`
Expected: PASS (أو لا فشل جديد متعلق بالتغيير).

- [ ] **Step 5: Commit**
```bash
git add src/workers/ai-worker.js
git commit -m "feat(worker): combine verbatim instant reply with AI answer"
```

---

## Task 4: إثبات حيّ قبل/بعد (gpt-4o)

**Files:**
- Create: `scripts/eval/instant-plus-answer-eval.js`

- [ ] **Step 1: harness** — أنشئ `scripts/eval/instant-plus-answer-eval.js`: config فيه `autoReplyKeywords={'السلام عليكم':'وعليكم السلام، حياك الله في برو'}` ومنتجات أدوبي، يستدعي مسار الرد لـ "السلام عليكم بكم ادوبي 4 أشهر؟" و"السلام عليكم وش الشحن وبكم ادوبي؟". المفتاح من `EVAL_API_KEY`. لا CI. (محتوى يحاكي ai-worker: collectInstantReplies + getReply(instantAnswered) + الإلصاق.)
```js
'use strict';
const path=require('path');
const AIClient=require(path.join(__dirname,'..','..','lib','ai-client'));
const {DEFAULT_CONFIG}=require(path.join(__dirname,'..','..','lib','constants'));
const {collectInstantReplies}=require(path.join(__dirname,'..','..','src','services','bot','platform-features'));
const KEY=process.env.EVAL_API_KEY; if(!KEY){console.error('set EVAL_API_KEY');process.exit(1);}
const cfg={...DEFAULT_CONFIG,model:'gpt-4o',openaiApiKey:KEY,storeName:'برو',maxResponseLength:160,
  autoReplyKeywords:{'السلام عليكم':'وعليكم السلام، حياك الله في برو'},
  replyStyle:{...DEFAULT_CONFIG.replyStyle,employeeName:'محمد',useShortReplies:true,replyLength:'short'},
  products:[{name:'اشتراك ادوبي',variants:[{label:'شهر',price:'59 ريال'},{label:'4 أشهر',price:'120 ريال'}]}]};
async function run(text){
  const {matched}=collectInstantReplies(cfg,text);
  const prefix=matched.map(m=>m.reply).join('\n');
  const ai=new AIClient(cfg,{info(){},warn(){},error(){}},{record(){}});
  const r=String(await ai.getReply([{role:'user',content:text}],{isFirstMsg:true,instantAnswered:prefix})||'').trim();
  const aiPart=(r&&r!==prefix)?'\n'+r:'';
  console.log('عميل: '+text+'\nبوت :\n'+(prefix+aiPart).trim()+'\n---');
}
(async()=>{ for(const t of ['السلام عليكم بكم ادوبي 4 أشهر؟','السلام عليكم وش الشحن وبكم ادوبي؟']) await run(t); })().catch(e=>{console.error('ERR',e.message);process.exit(1);});
```

- [ ] **Step 2: الحزمة الكاملة** — `node --test` (الفشل البيئي runtime-bot-stability فقط مقبول).

- [ ] **Step 3: Commit**
```bash
git add scripts/eval/instant-plus-answer-eval.js
git commit -m "chore(eval): instant-reply + answer before/after harness"
```

---

## Self-Review
- **تغطية:** كشف المطابقة + السؤال الزائد (Task 1)، تعليمة عدم التكرار (Task 2)، الإلصاق الحرفي + المسار السريع + fallback (Task 3)، إثبات (Task 4). أسئلة متعددة مغطّاة (الذكاء يجاوب الباقي).
- **عدم كسر القائم:** `findAutoReply` لم يُلمَس → اختباراته تبقى. التغيير في ai-worker يستخدم `collectInstantReplies`.
- **اتساق:** `collectInstantReplies` ترجع `{matched:[{keyword,reply}], hasExtraQuestion}` وتُستهلك في Task 3/4. `opts.instantAnswered` معرّف Task 2 ويُمرَّر Task 3.
- **مخاطر:** عتبة "≥2 كلمة" قد تُدخل وضع الدمج لسؤال موضوع مفصّل (مثل "كم سعر الشحن للرياض") — مقبول (canned + AI، والذكاء يُمنع من التكرار). fallback عند فشل الذكاء يضمن وصول الرد الفوري.
