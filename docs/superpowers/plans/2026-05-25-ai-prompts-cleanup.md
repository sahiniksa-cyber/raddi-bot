# AI Prompts Cleanup + Custom Avoid Phrases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip quote-priming from the AI system prompt and give the store owner a dashboard field for "avoid phrases" enforced by a deterministic post-processing filter.

**Architecture:** Two isolated components. (1) `buildSystemPrompt` in `lib/ai-client.js` loses its internal quote marks and gets positive-phrased rules — pure prompt edits. (2) A new `lib/post-process-reply.js` module is invoked from `AIClient.getReply` right before returning the reply; it strips quote characters and any phrase configured under `config.replyStyle.avoidPhrases`. Dashboard adds a chip-style UI for managing the list (same pattern as the existing `avoidWords`).

**Tech Stack:** Node.js `node:test`, vanilla JS dashboard, existing `chips` UI pattern, OpenAI SDK with Gemini/Claude/GPT.

**Spec:** [docs/superpowers/specs/2026-05-25-ai-prompts-cleanup-design.md](../specs/2026-05-25-ai-prompts-cleanup-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/post-process-reply.js` | `stripAvoidedContent(reply, config)` — strip quotes + avoid phrases | Create |
| `lib/ai-client.js` | `buildSystemPrompt` cleaned of internal quotes + integrate filter in `getReply` | Modify |
| `lib/constants.js` | Add `avoidPhrases: []` to `DEFAULT_CONFIG.replyStyle` | Modify |
| `dashboard/index.html` | New chip panel for `avoidPhrases` + JS for load/save | Modify |
| `tests/post-process-reply.test.js` | Unit tests for the filter | Create |
| `tests/ai-client-prompt.test.js` | Snapshot-style test asserting no internal quote marks | Create |

---

## Task 1: Create `lib/post-process-reply.js` with full TDD

**Files:**
- Create: `lib/post-process-reply.js`
- Create: `tests/post-process-reply.test.js`

- [ ] **Step 1: Create failing test file**

Create `tests/post-process-reply.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAvoidedContent } = require('../lib/post-process-reply');

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
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent matches avoidPhrases with Arabic letter variations (همزة/ألف)', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك استفسار'] } };
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
  assert.equal(stripAvoidedContent(undefined), '');
});

test('stripAvoidedContent preserves WhatsApp marker like [تحويل:...]', () => {
  const reply = 'خلني أحوّلك للمختص [تحويل:محمد|مشكلة دفع]';
  assert.equal(stripAvoidedContent(reply), reply);
});

test('stripAvoidedContent does not strip apostrophes between digits (e.g. measurements)', () => {
  // Single quotes between digits are preserved; this guards against over-stripping.
  assert.equal(stripAvoidedContent("القياس 5'2"), "القياس 5'2");
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

Run:
```
node --test tests/post-process-reply.test.js
```
Expected: FAIL with `Cannot find module '../lib/post-process-reply'`.

- [ ] **Step 3: Create `lib/post-process-reply.js` with full implementation**

Create `lib/post-process-reply.js`:

```js
'use strict';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeArabic(s) {
  return String(s || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function stripQuotes(text) {
  let out = text;
  // double quotes, French guillemets, backticks anywhere
  out = out.replace(/["«»]/g, '');
  // single quotes only when not between two digits (preserve 5'2 etc.)
  out = out.replace(/(^|[^\d])['`](?!\d)/g, '$1');
  out = out.replace(/(?<!\d)['`]/g, '');
  return out;
}

function stripPhrase(text, phrase) {
  const normalizedPhrase = normalizeArabic(phrase).toLowerCase();
  if (!normalizedPhrase) return text;
  const lines = text.split('\n');
  return lines.map(line => {
    const normalizedLine = normalizeArabic(line).toLowerCase();
    if (!normalizedLine.includes(normalizedPhrase)) return line;
    // strip every occurrence (slice by start index from normalized version)
    let working = line;
    let workingNormalized = normalizedLine;
    let idx;
    while ((idx = workingNormalized.indexOf(normalizedPhrase)) !== -1) {
      working = working.slice(0, idx) + working.slice(idx + phrase.length);
      workingNormalized = workingNormalized.slice(0, idx) + workingNormalized.slice(idx + normalizedPhrase.length);
    }
    return working;
  }).join('\n');
}

function tidyWhitespace(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([،.؟!]) ?/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+\./g, '.')
    .trim();
}

function stripAvoidedContent(reply, config = {}) {
  if (reply === null || reply === undefined) return '';
  if (typeof reply !== 'string') return String(reply || '');
  const original = reply;
  let cleaned = stripQuotes(reply);

  const phrases = Array.isArray(config?.replyStyle?.avoidPhrases)
    ? config.replyStyle.avoidPhrases.filter(p => typeof p === 'string' && p.trim())
    : [];
  for (const phrase of phrases) {
    cleaned = stripPhrase(cleaned, phrase.trim());
  }

  cleaned = tidyWhitespace(cleaned);

  if (!cleaned || cleaned.length < 3) return original.trim();
  return cleaned;
}

module.exports = { stripAvoidedContent };
```

- [ ] **Step 4: Run tests — confirm PASS**

Run:
```
node --test tests/post-process-reply.test.js
```
Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```
git add lib/post-process-reply.js tests/post-process-reply.test.js
git commit -m "$(cat <<'EOF'
feat(ai): add stripAvoidedContent post-process filter

New module that strips quote marks and configured avoid-phrases from
AI replies before delivery. Arabic-normalization aware (همزة/ألف) and
safe by design (falls back to the original reply if filtering would
empty it).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Default `avoidPhrases: []` in DEFAULT_CONFIG

**Files:**
- Modify: `lib/constants.js:57-60`

- [ ] **Step 1: Update `lib/constants.js`**

In `lib/constants.js`, replace the `replyStyle` block (lines 57-60):

**BEFORE:**
```js
  replyStyle: {
    tone: 'ودي ومحترم', useDialect: true, dialect: 'السعودية الخفيفة',
    emojiLevel: 'medium', useShortReplies: false,
  },
```

**AFTER:**
```js
  replyStyle: {
    tone: 'ودي ومحترم', useDialect: true, dialect: 'السعودية الخفيفة',
    emojiLevel: 'medium', useShortReplies: false,
    avoidPhrases: [],
  },
```

- [ ] **Step 2: Verify nothing broke**

Run:
```
node --test "tests/*.test.js" 2>&1 | tail -10
```
Expected: All tests still pass (no regression from a default-config tweak).

- [ ] **Step 3: Commit**

```
git add lib/constants.js
git commit -m "$(cat <<'EOF'
feat(constants): add avoidPhrases default to replyStyle

Empty array by default — bots without the field continue to work
unchanged. Used by stripAvoidedContent post-processing filter.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Clean `buildSystemPrompt` — remove internal quotes

**Files:**
- Modify: `lib/ai-client.js:100-191` (`buildSystemPrompt` method)

- [ ] **Step 1: Write the snapshot-style test FIRST**

Create `tests/ai-client-prompt.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');

function makeClient(overrides = {}) {
  const config = {
    storeName: 'متجري',
    welcomeMessage: 'هلا والله',
    model: 'google/gemini-2.0-flash',
    googleApiKey: 'AIzaSyDummyKeyForTesting1234',
    products: [{ name: 'منتج تجريبي', price: '99 ريال', description: 'وصف' }],
    escalationContacts: [{ name: 'محمد', phone: '0500000000', role: 'مدير', when: 'مشاكل' }],
    ...overrides,
  };
  return new AIClient(
    config,
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {}, save: () => {} },
  );
}

test('buildSystemPrompt does not wrap welcomeMessage in quote marks', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([], { isFirstMsg: true });
  assert.ok(!prompt.includes('"هلا والله"'), 'welcomeMessage must not appear wrapped in double quotes');
  assert.ok(!prompt.includes("'هلا والله'"), 'welcomeMessage must not appear wrapped in single quotes');
});

test('buildSystemPrompt does not wrap storeName in quote marks', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  assert.ok(!prompt.includes('"متجري"'), 'storeName must not appear wrapped in double quotes');
});

test('buildSystemPrompt does not contain quoted example phrases for the AI to mimic', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  assert.ok(!prompt.includes('"ثانية بس"'), 'example casual phrases must not be in quote marks');
  assert.ok(!prompt.includes('"خلني أشوف"'), 'example casual phrases must not be in quote marks');
  assert.ok(!prompt.includes('"خلني أحوّلك للمختص"'), 'escalation example must not be in quote marks');
});

test('buildSystemPrompt still includes the store name and welcome message somewhere', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([], { isFirstMsg: true });
  assert.ok(prompt.includes('متجري'), 'storeName must appear in the prompt');
  assert.ok(prompt.includes('هلا والله'), 'welcomeMessage must appear in the prompt');
});

test('buildSystemPrompt has positive-phrased rules instead of "ممنوع" block', () => {
  const ai = makeClient();
  const prompt = ai.buildSystemPrompt([]);
  // The new rule block uses ✅ القواعد الذهبية
  assert.match(prompt, /القواعد الذهبية/);
});
```

- [ ] **Step 2: Run the test — confirm FAIL**

Run:
```
node --test tests/ai-client-prompt.test.js
```
Expected: At least 3 of 5 tests FAIL (the current code embeds quotes and uses "🚫 ممنوع").

- [ ] **Step 3: Replace the relevant sections in `lib/ai-client.js`**

Make these 5 edits in `lib/ai-client.js`.

**Edit A** — lines 113-114 (productsBlock fallback string):

**BEFORE:**
```js
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، قل: "خلني أتأكد لك من التوفر")';
```

**AFTER:**
```js
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، أجب بأنك ستتأكد من التوفر وتعود إليه)';
```

**Edit B** — lines 121-127 (welcomeHint block):

**BEFORE:**
```js
    const welcomeHint = (isFirstMsg && welcomeMode === 'inline' && this.config.welcomeMessage?.trim())
      ? `\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي بنفس روح: "${this.config.welcomeMessage}" ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
      : (isFirstMsg && welcomeMode === 'separate')
      ? '\n\n💬 ملاحظة: تم إرسال ترحيب للعميل — اكتب رد يجاوب على طلبه مباشرة.'
      : '';
```

**AFTER:**
```js
    const welcomeHint = (isFirstMsg && welcomeMode === 'inline' && this.config.welcomeMessage?.trim())
      ? `\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي مشابه لـ ⟪${this.config.welcomeMessage}⟫ ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
      : (isFirstMsg && welcomeMode === 'separate')
      ? '\n\n💬 ملاحظة: تم إرسال ترحيب للعميل — اكتب رد يجاوب على طلبه مباشرة.'
      : '';
```

**Edit C** — lines 140-142 (escalation block example):

**BEFORE:**
```js
طريقة التحويل: أجب العميل أولاً (مثلاً: "خلني أحوّلك للمختص")، ثم يجب أن تضيف في آخر ردك هذه العلامة الخاصة:
[تحويل:اسم_الشخص|ملخص المشكلة بالتفصيل]
مثال: خلني أحوّلك لأحمد يساعدك بالموضوع [تحويل:أحمد|العميل لديه مشكلة في طلب 5432 لم يصل]
```

**AFTER:**
```js
طريقة التحويل: أجب العميل أولاً بجملة تشرح أنك ستحوّله للمختص، ثم يجب أن تضيف في آخر ردك هذه العلامة الخاصة:
[تحويل:اسم_الشخص|ملخص المشكلة بالتفصيل]
مثال: خلني أحوّلك لأحمد يساعدك بالموضوع [تحويل:أحمد|العميل لديه مشكلة في طلب 5432 لم يصل]
```

**Edit D** — line 160 (bot-identity line):

**BEFORE:**
```js
أنت إنسان حقيقي. لو سُئلت "هل أنت بوت؟" قل: "لا، أنا ${employeeName} من فريق ${this.config.storeName || 'المتجر'}".
```

**AFTER:**
```js
أنت إنسان حقيقي. لو سُئلت إن كنت بوتاً، أكّد أنك ${employeeName} من فريق ${this.config.storeName || 'المتجر'}.
```

**Edit E** — lines 159 and 164 (heading lines that wrap storeName in quotes):

**BEFORE (line 159):**
```js
    return `أنت ${employeeName}، موظف خدمة عملاء بشري في متجر "${this.config.storeName || 'المتجر'}".
```

**AFTER (line 159):**
```js
    return `أنت ${employeeName}، موظف خدمة عملاء بشري في متجر ${this.config.storeName || 'المتجر'}.
```

(Line 164-167 already use `الاسم: ${this.config.storeName}` without quotes — no change needed.)

**Edit F** — lines 178 (casual phrase examples):

**BEFORE:**
```js
- اكتب عفوي بشري: "ثانية بس"، "خلني أشوف"، "والله"
```

**AFTER:**
```js
- اكتب بأسلوب بشري عفوي مثل: ثانية بس / خلني أشوف / والله
```

**Edit G** — lines 186-190 (replace "🚫 ممنوع" block with positive rules):

**BEFORE:**
```js
🚫 ممنوع:
- قول هذه الكلمات أبداً: ${avoid}
- تكرار الترحيب إذا كنت رحبت في رسالة سابقة

⚡ مهم: ركّز على آخر رسالة من العميل وأجب عليها.${knowledgeRules}${escalationBlock}${welcomeHint}`;
```

**AFTER:**
```js
✅ القواعد الذهبية:
- اكتب كأنك ترسل رسائل واتساب عادية: بدون علامات اقتباس حول كلامك (لا " ولا ' ولا «»)
- لو رحبت بالعميل سابقاً، انتقل مباشرة للمحتوى بدون إعادة ترحيب
- اختم بسؤال محدد عن طلب العميل بدل عبارات عامة (مثل: إذا عندك أي استفسار)
- لا تستخدم هذه التعبيرات في أي رد: ${avoid}

⚡ مهم: ركّز على آخر رسالة من العميل وأجب عليها.${knowledgeRules}${escalationBlock}${welcomeHint}`;
```

- [ ] **Step 4: Run tests — confirm PASS**

Run:
```
node --test tests/ai-client-prompt.test.js
```
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```
git add lib/ai-client.js tests/ai-client-prompt.test.js
git commit -m "$(cat <<'EOF'
feat(ai): clean internal quote marks from buildSystemPrompt

The system prompt was teaching the model to use quote marks by example.
This change replaces internal "double quotes" with bracket delimiters
(⟪⟫) for dynamic variables and removes quote-wrapped example phrases
("ثانية بس") in favor of slash-separated lists. The negative
"🚫 ممنوع" block becomes a positive "✅ القواعد الذهبية" set of rules,
including an explicit no-quote-marks instruction. Snapshot tests guard
against future regressions.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `stripAvoidedContent` into `AIClient.getReply`

**Files:**
- Modify: `lib/ai-client.js` (top of file: add import; inside `getReply` near line 230-236)

- [ ] **Step 1: Add import at the top of `lib/ai-client.js`**

After the existing requires near the top (around line 19-20), add:

```js
const { stripAvoidedContent } = require('./post-process-reply');
```

- [ ] **Step 2: Apply the filter to the reply**

In `lib/ai-client.js`, inside `getReply`, find the success branch (around line 229-236):

**BEFORE:**
```js
        const res = await openai.chat.completions.create({ model, max_tokens: maxTokens, temperature: 0.3, messages }, { timeout: 30000 });
        const reply = res.choices[0]?.message?.content || '';
        if (res.usage) this.costTracker.record(model, res.usage.prompt_tokens || 0, res.usage.completion_tokens || 0);
        if (!reply.trim()) { this.logger.warn('ai', 'الـ AI رد بنص فارغ!'); this.lastDebug.error = 'empty reply'; }
        else { this.logger.info('ai', `📥 رد: "${reply.substring(0, 80)}"`); }
        this.lastDebug.reply = reply;
        this.lastDebug.success = true;
        return reply;
```

**AFTER:**
```js
        const res = await openai.chat.completions.create({ model, max_tokens: maxTokens, temperature: 0.3, messages }, { timeout: 30000 });
        const rawReply = res.choices[0]?.message?.content || '';
        const reply = stripAvoidedContent(rawReply, this.config);
        if (res.usage) this.costTracker.record(model, res.usage.prompt_tokens || 0, res.usage.completion_tokens || 0);
        if (!reply.trim()) { this.logger.warn('ai', 'الـ AI رد بنص فارغ!'); this.lastDebug.error = 'empty reply'; }
        else { this.logger.info('ai', `📥 رد: ${reply.substring(0, 80)}`); }
        if (rawReply !== reply) {
          this.logger.info('ai', `✂️ post-process: ${rawReply.length} → ${reply.length}`);
        }
        this.lastDebug.reply = reply;
        this.lastDebug.rawReply = rawReply;
        this.lastDebug.success = true;
        return reply;
```

(Also removed the `"..."` around the log preview — small detail that keeps logs quote-free.)

- [ ] **Step 3: Add an integration test**

Append to `tests/ai-client-prompt.test.js`:

```js
test('AIClient export contains stripAvoidedContent integration in getReply', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.match(src, /stripAvoidedContent/);
  assert.match(src, /require\(['"]\.\/post-process-reply['"]\)/);
});
```

- [ ] **Step 4: Run the test — confirm PASS**

Run:
```
node --test tests/ai-client-prompt.test.js
```
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```
git add lib/ai-client.js tests/ai-client-prompt.test.js
git commit -m "$(cat <<'EOF'
feat(ai): apply stripAvoidedContent to every AI reply

The post-processing filter now runs on every reply produced by
AIClient.getReply, stripping wrapping/internal quote marks and any
phrase configured under config.replyStyle.avoidPhrases. Both the
raw reply and the cleaned reply are stored in lastDebug for
diagnostics; the log line shows the size delta when filtering
changed anything.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Dashboard UI for `avoidPhrases`

**Files:**
- Modify: `dashboard/index.html` (4 small edits)

- [ ] **Step 1: Add the chip panel HTML beside the existing "كلمات ممنوعة" panel**

In `dashboard/index.html`, find the existing "Avoid words" block (line 1138-1144):

```html
      <!-- Avoid words -->
      <label>كلمات ممنوعة (لا يقولها البوت أبداً)</label>
      <div class="chips" id="avoidChips">
        <input type="text" id="avoidInput" placeholder="مثال: ChatGPT، نموذج لغة" onkeydown="if(event.key==='Enter'){event.preventDefault();addAvoid()}">
        <button class="chip-add" onclick="addAvoid()">+ إضافة</button>
      </div>
      <div class="hint">الافتراضي يمنع: أنا AI، نموذج لغة، روبوت، ChatGPT، OpenAI</div>
```

**Immediately after** that block (before the next `<!-- Custom instructions ... -->`), insert:

```html
      <!-- Avoid phrases -->
      <label style="margin-top:10px">✏️ عبارات ممنوعة (جمل كاملة لا يقولها البوت)</label>
      <div class="chips" id="avoidPhrasesChips">
        <input type="text" id="avoidPhrasesInput" placeholder="مثال: إذا عندك أي استفسار أنا موجود" onkeydown="if(event.key==='Enter'){event.preventDefault();addAvoidPhrase()}">
        <button class="chip-add" onclick="addAvoidPhrase()">+ إضافة</button>
      </div>
      <div class="hint">اكتب جملة كاملة كما يقولها البوت — يحذفها من الرد تلقائياً قبل الإرسال للعميل</div>
```

- [ ] **Step 2: Add the `addAvoidPhrase` JS function**

Find line 1943:
```js
function addAvoid(){const i=document.getElementById('avoidInput');if(i.value.trim()){insertChip('avoidChips',i.value.trim());i.value='';}}
```

Add a new line immediately after it:
```js
function addAvoidPhrase(){const i=document.getElementById('avoidPhrasesInput');if(i.value.trim()){insertChip('avoidPhrasesChips',i.value.trim());i.value='';}}
```

- [ ] **Step 3: Render avoidPhrases on load**

Find line 1853:
```js
  renderChips('avoidChips',r.avoidWords||[]);
```

Add a new line immediately after it:
```js
  renderChips('avoidPhrasesChips',r.avoidPhrases||[]);
```

- [ ] **Step 4: Save avoidPhrases on submit**

Find line 2263 (inside `replyStyle` object in `saveConf`):
```js
    avoidWords:getChips('avoidChips'),
```

Add a new line immediately after it:
```js
    avoidPhrases:getChips('avoidPhrasesChips'),
```

- [ ] **Step 5: Syntax sanity check**

Run:
```
node -e "const fs = require('fs'); const html = fs.readFileSync('dashboard/index.html', 'utf8'); console.log('avoidPhrases occurrences:', (html.match(/avoidPhrases/g) || []).length); console.log('addAvoidPhrase occurrences:', (html.match(/addAvoidPhrase/g) || []).length);"
```
Expected:
```
avoidPhrases occurrences: 4   (chip-container id + input id + load + save)
addAvoidPhrase occurrences: 3 (the function def + the input onkeydown + the button onclick)
```

- [ ] **Step 6: Commit**

```
git add dashboard/index.html
git commit -m "$(cat <<'EOF'
feat(dashboard): "عبارات ممنوعة" chip panel for AI reply post-processing

New chip-style input next to "كلمات ممنوعة". Each chip is a full phrase
that the post-processing filter will strip from every AI reply before
delivery (e.g. "إذا عندك أي استفسار أنا موجود"). Persisted under
config.replyStyle.avoidPhrases.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full test suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

Run:
```
node --test "tests/*.test.js" 2>&1 | tail -15
```
Expected: `# tests` count is the previous 178 plus 14 new (9 from post-process + 5 from ai-client-prompt + 1 integration) = **193 total, all passing**.

- [ ] **Step 2: If any test fails, STOP**

Read the failure. If it's a regression I caused, fix it. If it's pre-existing flakiness, document it and pause for human review. Do not proceed if there are failures attributable to this PR.

---

## Task 7: PR + merge + Railway deploy

**Files:** none (deployment only)

- [ ] **Step 1: Push the branch**

Run:
```
git push 2>&1
```
Expected: Push succeeds.

- [ ] **Step 2: Create the PR**

Run:
```
gh pr create --title "feat: AI prompts cleanup + dashboard avoid phrases" --body "$(cat <<'EOF'
## Summary
- Strip internal quote marks from \`buildSystemPrompt\` so the model stops mimicking them
- Convert negative "🚫 ممنوع" rules to positive "✅ القواعد الذهبية"
- New \`stripAvoidedContent\` post-process filter wired into every reply
- Dashboard chip panel "عبارات ممنوعة" for owner-controlled phrase blocklist

## Why
The store owner reported the AI was using quote marks and stock phrases like "إذا عندك أي استفسار أنا موجود" despite explicit prompt instructions. Root cause: the system prompt itself embedded quote marks (priming effect) and used negative phrasing the model couldn't reliably obey. Fix is two-fold: (1) clean the prompt, (2) deterministic post-processing.

## What changed
- \`lib/ai-client.js\` — \`buildSystemPrompt\` no longer wraps dynamic variables or example phrases in quotes; new positive rule block; \`getReply\` applies \`stripAvoidedContent\` before returning
- \`lib/post-process-reply.js\` (new) — strips quote marks + configured phrases with Arabic letter normalization
- \`lib/constants.js\` — \`DEFAULT_CONFIG.replyStyle.avoidPhrases\` defaults to \`[]\`
- \`dashboard/index.html\` — new chip panel + JS for load/save
- 14 new tests (post-process unit tests + prompt snapshot tests)

## What did NOT change
- DB schema, migrations, queues, Baileys, escalation routing — all untouched
- API contract — payload gains an optional \`replyStyle.avoidPhrases\` field, absent payloads keep working
- Existing \`replyStyle.avoidWords\` field — left intact

## Test plan
- [x] \`node --test "tests/*.test.js"\` passes locally
- [ ] After Railway deploy, add a phrase like "إذا عندك أي استفسار" in dashboard → trigger a reply that would naturally contain it → verify it gets stripped
- [ ] Trigger a normal reply → verify no quote marks around the reply text

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Merge**

Run:
```
gh pr merge --squash 2>&1
gh pr view --json state,mergeCommit
```
Expected: `state: MERGED`.

- [ ] **Step 4: Verify Railway deploy**

After ~2-3 minutes:
1. Check Railway logs for the new deploy commit SHA
2. In the dashboard, open the Reply Style panel and verify the new "عبارات ممنوعة" chip panel appears
3. Send a test message through WhatsApp and verify replies no longer contain quote marks

---

## Self-Review

### 1. Spec coverage
- ✅ Strip 6 internal quote-wrapping locations → Task 3 (Edits A–G)
- ✅ Convert "🚫 ممنوع" to positive rules → Task 3 (Edit G)
- ✅ Create `lib/post-process-reply.js` → Task 1
- ✅ Default `avoidPhrases: []` in DEFAULT_CONFIG → Task 2
- ✅ Wire filter into `getReply` → Task 4
- ✅ Dashboard UI (panel + load + save) → Task 5
- ✅ Tests for filter behavior → Task 1 (9 tests)
- ✅ Tests for cleaned prompt → Task 3 (5 tests) + Task 4 (1 integration test)
- ✅ Full suite verification → Task 6
- ✅ PR + merge + deploy → Task 7

### 2. Placeholder scan
- No "TBD", "TODO", or "similar to" phrasing.
- Every code step includes complete code.
- Every command step has explicit expected output.

### 3. Type consistency
- `stripAvoidedContent(reply, config)` signature matches across spec, tests, integration in `getReply`, and module export.
- `config.replyStyle.avoidPhrases` field name is identical in `DEFAULT_CONFIG`, dashboard load (`r.avoidPhrases`), dashboard save (`avoidPhrases:getChips(...)`), and filter (`config?.replyStyle?.avoidPhrases`).
- Chip container id `avoidPhrasesChips` is used consistently in HTML, `renderChips`, `getChips`, and `insertChip`.

Plan is consistent and complete.
