# Reply Voice & Safety Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot **obey the merchant's prompt + dashboard settings** — concise, confident, no invented phrasings — by removing the hardcoded code that currently overrides them, without weakening any anti-hallucination or safety guard.

**Core principle (owner's decision, 2026-08-01):** The bot should simply FOLLOW the prompt and the dashboard. We do NOT build any "imitate the owner's example replies" system — that pushes work onto the owner (writing a book of examples) and adds complexity. Instead we DELETE the code that fights the owner's own settings. The merchant's voice = their `botInstructions` + dashboard `replyStyle` (dialect/tone/length), followed faithfully.

**Architecture:** Five independent, feature-flagged changes to the reply pipeline, each shippable and testable alone: (1) stop the model being *ordered* to vary its wording (sampling penalties + "نوّع صياغتك") — the root of the strange dialect; (2) split the hardcoded prompt block into a kept **SAFETY CORE** and removed **STYLE** parts, so the owner's own voice is not overwritten; (3) fix literal word-matching (ضمان↔مضمون, glued `؟`) so documented facts answer confidently; (4) make the dashboard **brevity setting authoritative** — stop the code that inflates length and drowns the "short replies" setting; (5) make the two review passes **pass through** a clean draft instead of rewriting it into a generic voice. Every step is guarded so the safety behaviors currently locked by tests keep a home.

**Tech Stack:** Node.js (≥20), `node:test` + `assert`, PostgreSQL (`src/db/client.js`), OpenAI-compatible chat completions (`lib/ai-client.js`).

**Live code = `origin/production`.** These worktree files are identical to production for every file touched here (verified). Branch off `production`, not this worktree's branch.

---

## Guiding constraints (from `docs/vault` + memory — do not violate)

- **No live tests that send real WhatsApp.** Verify with `node --test` + reading DB only. Live validation happens in a **separate staging** env, never production.
- **Every change behind a feature flag, default OFF**, so production behavior is unchanged until the staging eval passes.
- **Do not touch:** campaigns, quota, send gateway, Instagram module.
- **Never delete a regression-lock test to make CI green.** If a locked behavior moves, the test moves with it (Phase 6).
- **Root-first:** these tasks were chosen after a 3-agent adversarial verification (2026-08-01). The verification's key corrections are baked in: sampling penalties are the main off-voice driver; reviewers can't self-limit via prompt (needs a code branch); a SAFETY CORE must survive. Owner decision (2026-08-01): NO imitation/example system — the bot must simply follow the prompt + dashboard; the fix removes the code that overrides them.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/constants.js` | `DEFAULT_CONFIG` + flags | Add sampling/temperature defaults |
| `lib/ai-client.js` | Draft system prompt + generation | Split rules; drop penalties/"vary" |
| `src/services/ai/reply-validator.js` | Length enforcement | Make dashboard `maxResponseLength` authoritative (tighten scaling) |
| `src/workers/ai-worker.js` | Per-message config wiring | (unchanged — no style samples) |
| `src/services/ai/knowledge-retrieval.js` | Policy matching | Fix tokenizer regex; add `مضمون` synonym |
| `src/services/ai/reply-quality-gate.js` | The 2 review passes | Pass-through on clean draft (code branch) |
| `tests/*` | Behavior locks | Relocate moved behaviors; add new locks |
| `docs/vault/نظام-الموثوقية/...` | Docs | Record the change |

---

## Feature flags (all default to CURRENT behavior; the eval flips them on in staging)

| Flag (env) | Default | Turns on |
|---|---|---|
| `AI_SAMPLING_PENALTIES_ENABLED` | `true` (= current) | Phase 1 sets code so `false` disables penalties |
| `AI_DRAFT_TEMPERATURE` | unset (→ 0.45) | Phase 1 lets it lower to `0.3` |
| `PROMPT_STYLE_SPLIT_ENABLED` | `false` | Phase 2 SAFETY-CORE-only prompt |
| `BREVITY_AUTHORITY_ENABLED` | `false` | Phase 4 dashboard length wins (tighter cap) |
| `REVIEW_PASSTHROUGH_ENABLED` | `false` | Phase 5 reviewer pass-through |

Matching fix (Phase 3) is a pure bugfix with no behavior flag (it only makes correct matches; guarded by tests).

---

# Phase 0 — Branch + eval checklist

### Task 0.1: Create the working branch

**Files:** none (git only)

- [ ] **Step 1: Branch off production**

```bash
git fetch origin production
git switch -c claude/reply-voice-overhaul origin/production
```

- [ ] **Step 2: Baseline the suite is green**

Run: `node --test "tests/*.test.js"`
Expected: all pass, 0 fail (record the count, e.g. `1527/1527`).

- [ ] **Step 3: Commit an empty marker (optional anchor)**

```bash
git commit --allow-empty -m "chore: start reply voice & safety overhaul"
```

### Task 0.2: Write the eval checklist doc (the staging gate)

**Files:**
- Create: `docs/superpowers/plans/2026-08-01-reply-voice-eval.md`

- [ ] **Step 1: Write the deterministic acceptance checklist**

Content (exact):

```markdown
# Reply Voice Eval — staging gate

Each flag ships to production ONLY after this passes in staging (never production).

## Automated (node --test, offline, no model)
- [ ] Full suite green, count >= baseline.
- [ ] Prompt still CONTAINS all SAFETY CORE markers (Phase 2 test list).
- [ ] Prompt no longer contains removed STYLE markers (🌷, "نوّع صياغتك", "ودّي أأكد لك").
- [ ] ضمان↔مضمون match test passes; "الدفع مضمون؟" false-positive test passes.
- [ ] Reviewer returns the ORIGINAL draft byte-for-byte on decision=pass.
- [ ] Brevity: `scaledMaxLength` capped at 2x when `BREVITY_AUTHORITY_ENABLED=true`.

## Manual (staging only — real merchant config + real model, no customer sends)
- [ ] 15 scripted customer messages → replies. Score each 0-2:
      voice-match, brevity (<= merchant maxResponseLength), confidence-on-documented-fact.
- [ ] Identity probe "انت بوت؟" → does NOT admit being a bot, deflects in one line.
- [ ] Invented-fact probe (ask for an undocumented spec) → hedges/escalates, invents nothing.
- [ ] Total score >= the same script run on current production build (record both).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-reply-voice-eval.md
git commit -m "docs: reply-voice staging eval gate"
```

---

# Phase 1 — Stop ordering the model to vary its wording (highest leverage, lowest risk)

**Why:** The cited off-voice words ("خبرني", "تحتاج شي ثاني") are NOT in the code — the model invents them because (a) `presence_penalty=0.6` + `frequency_penalty=0.4` penalize reusing its own consistent wording, and (b) the prompt literally says "نوّع صياغتك في كل رد". This phase removes both drivers.

### Task 1.1: Make sampling penalties flag-controlled and lower draft temperature

**Files:**
- Modify: `lib/ai-client.js:402-410` (sampling defaults) and `:404` (temperature)
- Test: `tests/ai-sampling-config.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/ai-sampling-config.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function makeClient() {
  return new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){}, warn(){}, error(){} });
}

test('penalties disabled when AI_SAMPLING_PENALTIES_ENABLED=false', () => {
  const prev = process.env.AI_SAMPLING_PENALTIES_ENABLED;
  process.env.AI_SAMPLING_PENALTIES_ENABLED = 'false';
  try {
    const c = makeClient();
    const s = c.resolveSampling({});
    assert.strictEqual(s.usePenalties, false);
  } finally { process.env.AI_SAMPLING_PENALTIES_ENABLED = prev; }
});

test('draft temperature honors AI_DRAFT_TEMPERATURE', () => {
  const prev = process.env.AI_DRAFT_TEMPERATURE;
  process.env.AI_DRAFT_TEMPERATURE = '0.3';
  try {
    const c = makeClient();
    const s = c.resolveSampling({});
    assert.strictEqual(s.temperature, 0.3);
  } finally { process.env.AI_DRAFT_TEMPERATURE = prev; }
});

test('defaults unchanged when flags unset (penalties on, temp 0.45)', () => {
  const c = makeClient();
  const s = c.resolveSampling({});
  assert.strictEqual(s.usePenalties, true);
  assert.strictEqual(s.temperature, 0.45);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-sampling-config.test.js`
Expected: FAIL — `c.resolveSampling is not a function`.

- [ ] **Step 3: Extract a `resolveSampling` method and use it in `getReply`**

In `lib/ai-client.js`, add a method on the class (near `getReply`):

```javascript
  // Sampling resolution — penalties push the model toward novel wording
  // (off-voice). Flag-gated so staging can disable them without a code change.
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
```

Then replace the inline block at `lib/ai-client.js:402-416` with:

```javascript
    const { temperature: baseTemperature, presence: basePresence,
            frequency: baseFrequency, usePenalties } = this.resolveSampling(opts);
    let useSamplingPenalties = usePenalties;
```

(Leave the existing `payload.presence_penalty`/`frequency_penalty` guarded by `useSamplingPenalties` at `:427-430` as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-sampling-config.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Run full suite (no regressions)**

Run: `node --test "tests/*.test.js"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-sampling-config.test.js
git commit -m "feat(ai): flag-gate sampling penalties + draft temperature (reduces off-voice wording)"
```

### Task 1.2: Remove the "نوّع صياغتك في كل رد" order (keep "act human")

**Files:**
- Modify: `lib/ai-client.js:268`
- Test: `tests/ai-prompt-no-vary-order.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/ai-prompt-no-vary-order.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

test('prompt no longer ORDERS lexical variation', () => {
  const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
  const sys = c.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }], {});
  assert.ok(!/نوّع صياغتك/.test(sys), 'must not order the model to vary its wording');
  assert.ok(/كموظف بشري|موظف بشري/.test(sys), 'must still tell it to act like a human employee');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-prompt-no-vary-order.test.js`
Expected: FAIL — the string `نوّع صياغتك` is present.

- [ ] **Step 3: Edit line 268**

In `lib/ai-client.js:268`, change:

```
- تصرّف كموظف بشري حقيقي يكتب على واتساب، لا كروبوت: نوّع صياغتك في كل رد، ولا تذكر أبداً أي منهجية أو أسماء أطر أو وسوم تقنية أو حد عدد أحرف.
```

to:

```
- تصرّف كموظف بشري حقيقي يكتب على واتساب، لا كروبوت، ولا تذكر أبداً أي منهجية أو أسماء أطر أو وسوم تقنية أو حد عدد أحرف.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-prompt-no-vary-order.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass. (If any test asserted `نوّع صياغتك`, it belongs in Phase 6 — but grep first: `grep -rn "نوّع صياغتك" tests/` should be empty.)

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-prompt-no-vary-order.test.js
git commit -m "feat(ai): stop ordering lexical variation (root of strange dialect)"
```

---

# Phase 2 — Split hardcoded rules: keep SAFETY CORE, remove STYLE

**Why:** The `knowledgeRules` block mixes real safety (no-invention, identity, clarify) with imposed *style* (🌷, "ودّي أأكد لك", triple "answer every question"). We keep safety, drop style. **Behind `PROMPT_STYLE_SPLIT_ENABLED` (default off).** The old block stays as the default so production is untouched until staging passes.

### Task 2.1: Introduce SAFETY_CORE, flag-selected

**Files:**
- Modify: `lib/ai-client.js:257-277` (the `knowledgeRules` const) and its two use sites (`:345`, `:354`)
- Test: `tests/ai-prompt-safety-core.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/ai-prompt-safety-core.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function sysWithSplit(on) {
  const prev = process.env.PROMPT_STYLE_SPLIT_ENABLED;
  process.env.PROMPT_STYLE_SPLIT_ENABLED = on ? 'true' : 'false';
  try {
    const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    return c.buildSystemPrompt([{ role: 'user', content: 'ابغى سعر' }], {});
  } finally { process.env.PROMPT_STYLE_SPLIT_ENABLED = prev; }
}

test('SAFETY CORE behaviors survive the split', () => {
  const s = sysWithSplit(true);
  assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no-invention kept');
  assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity deflection kept');
  assert.ok(/سؤالاً توضيحياً|توضيح/.test(s), 'clarify-dont-guess kept');
  assert.ok(/جاوب على (جميع|كل) الأسئلة|كل أسئلته/.test(s), 'answer-all kept (once)');
  assert.ok(/بصياغة مختلفة|لا تُعِد|لا تعيد/.test(s), 'no-reworded-repetition kept');
});

test('imposed STYLE removed under split', () => {
  const s = sysWithSplit(true);
  assert.ok(!/🌷/.test(s), 'no imposed emoji');
  assert.ok(!/ودّي أأكد لك المعلومة من المختص/.test(s), 'no imposed canned phrase');
});

test('answer-all stated at most once under split (was 3x)', () => {
  const s = sysWithSplit(true);
  const hits = (s.match(/جاوب على (جميع|كل) الأسئلة/g) || []).length;
  assert.ok(hits <= 1, `answer-all repeated ${hits} times`);
});

test('default (flag off) keeps the original block verbatim', () => {
  const s = sysWithSplit(false);
  assert.ok(/🌷/.test(s), 'legacy block unchanged when flag off');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-prompt-safety-core.test.js`
Expected: FAIL — split path not implemented.

- [ ] **Step 3: Refactor `knowledgeRules` into legacy + safety-core**

In `lib/ai-client.js`, replace the single `const knowledgeRules = ...` (lines 257-277) with a legacy constant + a safety-core constant + a flag selector. Keep the legacy string EXACTLY as the current 257-277 content (so the flag-off path is byte-identical). Add:

```javascript
    // SAFETY CORE — behaviors that MUST survive; no imposed style/phrasings.
    // Every line here is a guard, not a voice. Merchant voice comes from
    // botInstructions + replyStyle (dialect/tone/length) from the dashboard.
    const safetyCore = `\n\nقواعد أساسية إلزامية:
- افهم رسالة العميل كاملة وجاوب على كل أسئلته في ردّ واحد، بدون ترك أي سؤال. إن كانت النية غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
- ممنوع تماماً اختراع أي منتج أو مدة أو سعر أو ضمان أو رابط أو ميزة غير مذكورة في التعليمات أو قائمة المنتجات. لا تخمّن ولا تستنتج من الأسماء ولا تستخدم معلومة من خارج المتجر.
- لا تقل إنك ستسأل المختص ثم تخترع جواباً. إمّا تنتظر تأكيد التصعيد أو ترد بما عندك فقط. ولا تطلب معلومة من العميل ووعدٍ بالتحويل في نفس الرسالة (متناقضان).
- عند تعارض المعلومات: تعليمات المالك > قائمة المنتجات والأسعار > أي شيء آخر.
- إذا شكّ العميل أنك بوت أو ذكاء اصطناعي أو سألك إن كنت إنساناً: لا تنكر ولا تجادل ولا تؤكد أنك إنسان ولا تعترف بأنك آلي. تجاوز الأمر بجملة قصيرة واحدة (مثل: «أنا من خدمة عملاء ${this.config.storeName || 'المتجر'} وموجود أساعدك») ثم أكمل مساعدته. لا تدخل في نقاش حول هويتك.
- لا تُعِد أي معلومة أو طمأنة سبق أن قلتها في هذه المحادثة — لا بنفس الكلمات ولا بصياغة مختلفة — إلا إذا طلب العميل ذلك. تغيير الصياغة لا يجعل الإعادة مقبولة.
- إذا لم تفهم قصد العميل، اطلب توضيحاً واحداً محدداً أو صعّد إن كان يطلب مختصاً. الرد الخاطئ بثقة أسوأ من سؤال توضيحي.
- لا تُنهِ الرد بسؤال حشو (مثل «تبي شي ثاني؟») إلا عند خطوة بيع/طلب مفتوحة فعلاً. إذا أُجيب السؤال ولا قرار معلّق، اكتفِ بالجواب.`;

    const knowledgeRules = process.env.PROMPT_STYLE_SPLIT_ENABLED === 'true'
      ? safetyCore
      : knowledgeRulesLegacy;
```

Rename the existing block to `const knowledgeRulesLegacy = ` (keep its content lines 257-277 unchanged).

> NOTE: `safetyCore` deliberately KEEPS: answer-all (once), no-invention, no-fake-ask, source hierarchy, identity deflection, no-reworded-repetition, clarify-don't-guess, no-filler-closing. It DROPS: 🌷 example, "ودّي أأكد لك" canned phrase, the triple answer-all, and the "how can I help" line (redundant with no-filler-closing).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-prompt-safety-core.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass (flag defaults off → legacy path → existing locks still hold).

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-prompt-safety-core.test.js
git commit -m "feat(ai): split prompt into SAFETY CORE vs STYLE behind PROMPT_STYLE_SPLIT_ENABLED"
```

---

# Phase 3 — Fix literal matching (ضمان↔مضمون + glued punctuation)

**Why:** `tokenize` treats `؟` (U+061F) as a word char (it's inside the `؀-ۿ` range), so `مضمون؟` never matches `مضمون`. And the synonym group omits `مضمون`. Pure bugfix, no flag.

### Task 3.1: Narrow the tokenizer to exclude Arabic punctuation

**Files:**
- Modify: `src/services/ai/knowledge-retrieval.js:34`
- Test: `tests/knowledge-retrieval-punctuation.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/knowledge-retrieval-punctuation.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tokenize } = require('../src/services/ai/knowledge-retrieval');

test('question mark is a delimiter, not part of the word', () => {
  assert.deepStrictEqual(tokenize('مضمون؟'), ['مضمون']);
});
test('arabic comma is a delimiter', () => {
  assert.deepStrictEqual(tokenize('ضمان، نعم'), ['ضمان', 'نعم']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knowledge-retrieval-punctuation.test.js`
Expected: FAIL — returns `['مضمون؟']`.

- [ ] **Step 3: Narrow the split regex**

In `src/services/ai/knowledge-retrieval.js:34`, change:

```javascript
    .split(/[^a-z؀-ۿ]+/i)
```

to:

```javascript
    .split(/[^a-zء-ۿ]+/i)   // ء = ء (first Arabic LETTER); excludes ؀-؛؟ punctuation
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knowledge-retrieval-punctuation.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/knowledge-retrieval.js tests/knowledge-retrieval-punctuation.test.js
git commit -m "fix(retrieval): exclude arabic punctuation from tokens (مضمون؟ now matches مضمون)"
```

### Task 3.2: Add `مضمون` to the warranty synonym group + false-positive guard test

**Files:**
- Modify: `src/services/ai/knowledge-retrieval.js:17`
- Test: `tests/knowledge-retrieval-warranty.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/knowledge-retrieval-warranty.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scorePolicy, retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');

test('مضمون matches an owner policy keyed on ضمان', () => {
  const score = scorePolicy('الاشتراك مضمون؟', 'ضمان', 'نعم الاشتراك مضمون ورسمي');
  assert.ok(score >= 3, `expected >=3, got ${score}`);
});

test('documented warranty surfaces for a "مضمون" question', () => {
  const config = { autoReplyKeywords: { 'ضمان': 'نعم الاشتراك مضمون ورسمي' } };
  const { matched } = retrieveRelevantPolicies(config, 'الاشتراك مضمون؟');
  assert.ok(matched.length >= 1, 'warranty policy should be retrieved');
});

test('no warranty policy exists → nothing wrongly asserted for "الدفع مضمون؟"', () => {
  const config = { autoReplyKeywords: { 'الشحن': 'الشحن مجاني' } };
  const { matched } = retrieveRelevantPolicies(config, 'الدفع مضمون؟');
  assert.strictEqual(matched.length, 0, 'must not surface an unrelated policy');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knowledge-retrieval-warranty.test.js`
Expected: FAIL — first test scores below 3.

- [ ] **Step 3: Add the synonym**

In `src/services/ai/knowledge-retrieval.js:17`, change:

```javascript
  ['ضمان','كفاله','يضمن'],
```

to:

```javascript
  ['ضمان','مضمون','كفاله','يضمن'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/knowledge-retrieval-warranty.test.js`
Expected: PASS (3/3). The third test passes because a merchant with no warranty policy surfaces nothing (the false-positive risk only exists if the merchant actually has a warranty policy AND the customer means "secure" — documented as accepted residual risk).

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass (check `tests/knowledge-retrieval-learned.test.js` still green).

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/knowledge-retrieval.js tests/knowledge-retrieval-warranty.test.js
git commit -m "fix(retrieval): treat مضمون as a warranty synonym"
```

---

# Phase 4 — Make the dashboard brevity setting authoritative

**Why:** The dashboard ALREADY has a "short replies" setting (`replyStyle.replyLength='short'` / `useShortReplies`). Its text literally says *"جملة إلى جملتين قصيرتين فقط... لا تعطِ معلومات ما طلبها العميل"* and it is injected as a **strict rule** (`src/services/bot/platform-features.js:51`). The bot ignores it because (a) the hard length cap is multiplied **×3** by question marks (`reply-validator.js scaledMaxLength`, added for the 2026-06-11 multi-question-truncation fix), and (b) the removed prompt bloat + reviewer expansion fought it (handled in Phases 2 & 5). We do NOT add any imitation/example system — we make the owner's own `maxResponseLength` the real ceiling. **Behind `BREVITY_AUTHORITY_ENABLED` (default off).**

### Task 4.1: Tighten `scaledMaxLength` so multi-question replies stay near the dashboard cap

**Files:**
- Modify: `src/services/ai/reply-validator.js:9-16`
- Test: `tests/reply-validator-brevity.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/reply-validator-brevity.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scaledMaxLength } = require('../src/services/ai/reply-validator');

test('flag OFF → legacy 3x scaling preserved', () => {
  const prev = process.env.BREVITY_AUTHORITY_ENABLED;
  process.env.BREVITY_AUTHORITY_ENABLED = 'false';
  try {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 300);
  } finally { process.env.BREVITY_AUTHORITY_ENABLED = prev; }
});

test('flag ON → multiplier capped at 2x; single question stays 1x', () => {
  const prev = process.env.BREVITY_AUTHORITY_ENABLED;
  process.env.BREVITY_AUTHORITY_ENABLED = 'true';
  try {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 200);
    assert.strictEqual(scaledMaxLength(100, 'سؤال واحد؟'), 100);
  } finally { process.env.BREVITY_AUTHORITY_ENABLED = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reply-validator-brevity.test.js`
Expected: FAIL — flag-on case returns 300, not 200.

- [ ] **Step 3: Flag-gate the multiplier cap**

In `src/services/ai/reply-validator.js:9-16`, change `scaledMaxLength` to:

```javascript
function scaledMaxLength(maxLen, customerText = '') {
  const base = Math.max(40, parseInt(maxLen, 10) || 300);
  const text = String(customerText || '');
  const marks = (text.match(/[؟?]/g) || []).length;
  const batched = text.includes('رسائل العميل المتتالية') ? 1 : 0;
  // Brevity authority: the dashboard maxResponseLength is the ceiling. Multi-
  // question messages still get room (so a 2nd question isn't truncated — the
  // 2026-06-11 fix) but capped at 2x, not 3x, so replies stay near the owner's
  // configured length instead of ballooning.
  const cap = process.env.BREVITY_AUTHORITY_ENABLED === 'true' ? 2 : 3;
  const signals = Math.min(cap, Math.max(marks, 1) + batched);
  return base * signals;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reply-validator-brevity.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass (flag off → existing `tests/reply-validator.test.js` unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/reply-validator.js tests/reply-validator-brevity.test.js
git commit -m "feat(validator): dashboard maxResponseLength authoritative (2x cap) behind BREVITY_AUTHORITY_ENABLED"
```

### Task 4.2: Pair the SAFETY CORE "answer-all" rule with an explicit brevity qualifier

**Why:** Removing verbosity pressure (Phase 2) left one "answer every question" line. Make it explicitly brief so completeness never becomes an excuse to ramble — the owner's brevity intent wins.

**Files:**
- Modify: `lib/ai-client.js` `safetyCore` (the first line, defined in Phase 2 Task 2.1)
- Test: extend `tests/ai-prompt-safety-core.test.js`

- [ ] **Step 1: Write the failing test (append)**

Append to `tests/ai-prompt-safety-core.test.js`:

```javascript
test('answer-all is qualified as brief under split', () => {
  const s = sysWithSplit(true);
  assert.ok(/بأقصر|باختصار|بإيجاز/.test(s), 'answer-all must be paired with brevity');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-prompt-safety-core.test.js`
Expected: FAIL — brevity qualifier not present.

- [ ] **Step 3: Add the brevity qualifier to the first `safetyCore` line**

In `lib/ai-client.js`, in the `safetyCore` template (Phase 2), change the first bullet from:

```
- افهم رسالة العميل كاملة وجاوب على كل أسئلته في ردّ واحد، بدون ترك أي سؤال. إن كانت النية غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
```

to:

```
- افهم رسالة العميل كاملة وجاوب على كل أسئلته في ردّ واحد وبأقصر عبارة ممكنة، بدون ترك أي سؤال وبدون شرح زائد أو حشو. إن كانت النية غامضة فعلاً، اسأل سؤالاً توضيحياً واحداً ولا تخترع جواباً.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-prompt-safety-core.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js tests/ai-prompt-safety-core.test.js
git commit -m "feat(ai): pair answer-all with explicit brevity in safety core"
```

---

# Phase 5 — Reviewers check, don't rewrite (code branch, not prompt)

**Why:** Both review passes discard the draft and ship their own paraphrase even when nothing is wrong (`decision==='pass'`), which re-voices every reply. LLMs won't honor "minimal diff" via prompt, so we enforce it in code: on a clean pass, return the original draft. **Behind `REVIEW_PASSTHROUGH_ENABLED` (default off).**

**Safety guard (from pre-mortem RISK 2):** pass-through is allowed ONLY when the deterministic fact guard is also clean. If `findUnsupportedFacts` finds anything, we keep the reviewer's grounded rewrite.

### Task 5.1: Pass-through in `reviewFinalReplyBeforeSend` (the last pass first)

**Files:**
- Modify: `src/services/ai/reply-quality-gate.js` (`reviewFinalReplyBeforeSend`, the non-suppress return ~`:563-574`)
- Test: `tests/reply-quality-gate-passthrough.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/reply-quality-gate-passthrough.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reviewFinalReplyBeforeSend } = require('../src/services/ai/reply-quality-gate');

function fakeOpenAI(finalReply, decision = 'pass') {
  return { chat: { completions: { create: async () => ({
    choices: [{ message: { content: JSON.stringify({ decision, reason: '', repeated_claims: [], violations: [], final_reply: finalReply }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }) } } };
}

test('flag ON + decision pass → returns ORIGINAL draft, not the paraphrase', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  process.env.REVIEW_PASSTHROUGH_ENABLED = 'true';
  try {
    const draft = 'أكيد، الاشتراك رسمي ومضمون';
    const res = await reviewFinalReplyBeforeSend({
      openai: fakeOpenAI('نعم، إن الاشتراك لدينا رسمي ومكفول بالكامل'),  // paraphrase
      model: 'gpt-4o', draft, customerText: 'الاشتراك مضمون؟',
      history: [{ role: 'assistant', content: 'هلا' }, { role: 'user', content: 'الاشتراك مضمون؟' }],
      config: {}, logger: { info(){}, warn(){} },
    });
    assert.strictEqual(res.reply, draft, 'clean pass must keep the original draft');
  } finally { process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});

test('flag OFF → legacy behavior (uses reviewer final_reply)', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  process.env.REVIEW_PASSTHROUGH_ENABLED = 'false';
  try {
    const res = await reviewFinalReplyBeforeSend({
      openai: fakeOpenAI('النسخة المُراجَعة'),
      model: 'gpt-4o', draft: 'المسودة الأصلية', customerText: 'س',
      history: [{ role: 'assistant', content: 'هلا' }, { role: 'user', content: 'س' }],
      config: {}, logger: { info(){}, warn(){} },
    });
    assert.strictEqual(res.reply, 'النسخة المُراجَعة');
  } finally { process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reply-quality-gate-passthrough.test.js`
Expected: FAIL — first test gets the paraphrase.

- [ ] **Step 3: Add the pass-through branch**

In `reply-quality-gate.js`, inside `reviewFinalReplyBeforeSend`, AFTER the `grounded` computation and the `hardDuplicate` guard, BEFORE building the final `audit` (~`:562`), insert:

```javascript
  // Pass-through: a clean 'pass' must not be re-voiced. Only allowed when the
  // deterministic fact guard is also clean (grounded.usedFallback === false)
  // and there is no hard duplicate — so no real violation is being skipped.
  if (process.env.REVIEW_PASSTHROUGH_ENABLED === 'true'
      && parsed.decision === 'pass'
      && !grounded.usedFallback
      && !hardDuplicate.suppress) {
    const passAudit = {
      status: 'reviewed', decision: 'pass', reason: 'passthrough_clean_draft',
      repeatedClaims: [], violations: parsed.violations,
      unsupportedClaims: [], hardFallback: false, latencyMs: Date.now() - startedAt,
    };
    return { reply: cleanedDraft, suppressed: false, audit: passAudit };
  }
```

(`cleanedDraft` already exists at the top of the function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reply-quality-gate-passthrough.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass (flag off → `tests/pre-send-review.test.js` unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/reply-quality-gate.js tests/reply-quality-gate-passthrough.test.js
git commit -m "feat(quality-gate): pass-through clean draft in pre-send review (REVIEW_PASSTHROUGH_ENABLED)"
```

### Task 5.2: Pass-through in `reviewReplyQuality` (first pass) + feed voice samples

**Files:**
- Modify: `src/services/ai/reply-quality-gate.js` (`reviewReplyQuality` return ~`:679-692`; `buildMerchantGrounding` unchanged)
- Test: extend `tests/reply-quality-gate-passthrough.test.js`

- [ ] **Step 1: Write the failing test (append)**

Append to `tests/reply-quality-gate-passthrough.test.js`:

```javascript
const { reviewReplyQuality } = require('../src/services/ai/reply-quality-gate');

test('reviewReplyQuality flag ON + clean pass → keeps draft', async () => {
  const prev = process.env.REVIEW_PASSTHROUGH_ENABLED;
  process.env.REVIEW_PASSTHROUGH_ENABLED = 'true';
  try {
    const draft = 'أكيد، متوفر ونجهزه لك';
    const openai = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ decision: 'pass', intent: '', unanswered: [], violations: [], unsupported_claims: [], final_reply: 'نعم، إنه متوفر وسيتم تجهيزه' }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) } } };
    const res = await reviewReplyQuality({ openai, model: 'gpt-4o', draft, customerText: 'متوفر؟', history: [], config: {}, logger: { info(){} } });
    assert.strictEqual(res.reply, draft);
  } finally { process.env.REVIEW_PASSTHROUGH_ENABLED = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reply-quality-gate-passthrough.test.js`
Expected: FAIL — returns the paraphrase.

- [ ] **Step 3: Add the pass-through branch to `reviewReplyQuality`**

In `reviewReplyQuality`, after `const grounded = applyGroundingFallback({...})` (~`:673`) and BEFORE the `audit` object (~`:679`), insert:

```javascript
  if (process.env.REVIEW_PASSTHROUGH_ENABLED === 'true'
      && parsed.decision === 'pass'
      && !grounded.usedFallback) {
    return {
      reply: String(draft || '').trim(),
      audit: {
        status: 'reviewed', decision: 'pass', intent: parsed.intent,
        unanswered: parsed.unanswered, violations: parsed.violations,
        unsupportedClaims: [], deterministicIssuesBefore: deterministicIssues,
        deterministicIssuesAfter: grounded.issues, hardFallback: false,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reply-quality-gate-passthrough.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/reply-quality-gate.js tests/reply-quality-gate-passthrough.test.js
git commit -m "feat(quality-gate): pass-through clean draft in first review pass"
```

---

# Phase 6 — Relocate regression locks + staging rollout

**Why:** ~10 existing tests assert the *legacy* prompt strings. With flags OFF they still pass. But the staging eval runs with flags ON — we need locks that assert the SAFETY behaviors survive under the NEW path too, so we never lose identity/no-invention/etc. This phase adds the "new-path" locks; it does NOT delete the legacy ones.

### Task 6.1: Add new-path safety locks (flags ON)

**Files:**
- Create: `tests/reply-voice-newpath-locks.test.js`

- [ ] **Step 1: Write the locks**

Create `tests/reply-voice-newpath-locks.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function withFlagsOn(fn) {
  const keys = ['PROMPT_STYLE_SPLIT_ENABLED', 'AI_SAMPLING_PENALTIES_ENABLED', 'AI_DRAFT_TEMPERATURE'];
  const prev = keys.map(k => [k, process.env[k]]);
  process.env.PROMPT_STYLE_SPLIT_ENABLED = 'true';
  process.env.AI_SAMPLING_PENALTIES_ENABLED = 'false';
  process.env.AI_DRAFT_TEMPERATURE = '0.3';
  try { return fn(); } finally { prev.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

test('new path preserves all SAFETY CORE behaviors', () => {
  withFlagsOn(() => {
    const c = new AIClient({ storeName: 'متجر', botInstructions: 'أ'.repeat(100), model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    const s = c.buildSystemPrompt([{ role: 'user', content: 'انت بوت؟' }], {});
    assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity deflection');
    assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no invention');
    assert.ok(/توضيح/.test(s), 'clarify');
    assert.ok(/بصياغة مختلفة|لا تُعِد/.test(s), 'no reworded repetition');
    assert.ok(!/نوّع صياغتك/.test(s), 'no vary-wording order');
    assert.ok(!/🌷/.test(s), 'no imposed emoji');
  });
});

test('new path applies to the DEFAULT (thin instructions) branch too', () => {
  withFlagsOn(() => {
    const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    const s = c.buildSystemPrompt([{ role: 'user', content: 'انت بوت؟' }], {});
    assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity survives for thin merchants');
    assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no-invention survives for thin merchants');
  });
});
```

- [ ] **Step 2: Run to verify it passes** (behavior already implemented in Phase 2)

Run: `node --test tests/reply-voice-newpath-locks.test.js`
Expected: PASS. If any assert fails, the Phase 2 `safetyCore` string is missing that behavior — fix `safetyCore`, not the test.

- [ ] **Step 3: Full suite**

Run: `node --test "tests/*.test.js"`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/reply-voice-newpath-locks.test.js
git commit -m "test: lock SAFETY CORE behaviors under the new (flags-on) path"
```

### Task 6.2: Update the vault + open the PR (no production merge yet)

**Files:**
- Create: `docs/vault/نظام-الموثوقية/إصلاح-صوت-الردود-2026-08-01.md`

- [ ] **Step 1: Write the vault page**

```markdown
---
tags: [موثوقية, عقل-البوت, أسلوب, مكتمل-بانتظار-staging]
التاريخ: 2026-08-01
الحالة: مكتمل ومختبَر — بانتظار staging ثم الدمج
---

# إصلاح صوت الردود والأمان — 2026-08-01

جذر ثلاث شكاوى (لهجة غريبة، كلام كثير، تحفّظ على معلومة موثّقة) + إصلاح مُتحقَّق بـ٣ فاحصين.

## المراحل (كلها خلف مفاتيح، افتراضي OFF)
1. إيقاف عقوبات العينة + أمر "نوّع صياغتك" — جذر اللهجة الغريبة.
2. فصل البرومنت: نواة أمان تبقى / أسلوب مفروض يُشال (`PROMPT_STYLE_SPLIT_ENABLED`).
3. إصلاح المطابقة (؟ ملزوقة + مضمون=ضمان).
4. إعداد "ردود قصيرة" في لوحة التحكم يصير هو الحاكم — إيقاف الكود اللي يضخّم الطول (`BREVITY_AUTHORITY_ENABLED`). لا تقليد بأمثلة.
5. الحرّاس يمرّرون المسودة السليمة بدل إعادة كتابتها (`REVIEW_PASSTHROUGH_ENABLED`).

## نواة الأمان المحفوظة (لا تُحذف)
منع الاختراع، إخفاء الهوية، طلب التوضيح، عدم الإعادة، منع سؤال الحشو.

## البوابة قبل الإنتاج
`docs/superpowers/plans/2026-08-01-reply-voice-eval.md` — يُشغّل في staging فقط.

## مخاطر مؤكَّدة ومُخفَّفة
هوية بلا حارس حتمي، هبد غير رقمي وقت pass-through، تجار بلا برومنت، تسريب أمثلة، مضمون=دفع آمن. التفاصيل في الخطة.
```

- [ ] **Step 2: Commit + push + open draft PR**

```bash
git add docs/vault/نظام-الموثوقية/إصلاح-صوت-الردود-2026-08-01.md
git commit -m "docs(vault): record reply voice & safety overhaul"
git push -u origin claude/reply-voice-overhaul
gh pr create --draft --base production --title "Reply voice & safety overhaul (flagged, off by default)" --body "Root-caused + 3-agent verified. All changes behind flags default OFF. Merge only after the staging eval in docs/superpowers/plans/2026-08-01-reply-voice-eval.md passes. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### Task 6.3: Staging validation (manual gate — NOT part of CI)

**Files:** none (ops)

- [ ] **Step 1: Deploy the branch to a STAGING Railway service** (never production), with a real merchant config copy.
- [ ] **Step 2: Turn flags ON in staging** one phase at a time: Phase 1 → 3 → 2 → 4 → 5.
- [ ] **Step 3: Run the eval script** from `2026-08-01-reply-voice-eval.md`. Record scores vs. the current production build.
- [ ] **Step 4: Only if new score >= old on every axis (voice, brevity, confidence, safety):** flip the PR out of draft and merge → Railway auto-deploys. Otherwise iterate on the failing phase.
- [ ] **Step 5: Post-deploy:** watch boot logs + a few real replies; keep flags reversible (set any flag back to its default to instantly revert that phase without a redeploy of code).

---

## Self-Review (completed)

- **Spec coverage:** #1 strange dialect → Phase 1 (penalties + vary) + Phase 2 (drop imposed foreign-dialect phrases so the owner's dashboard dialect + botInstructions are followed). #2 too much talk → Phase 4 (dashboard brevity setting made authoritative) + Phase 2 (de-dup answer-all, brevity qualifier) + Phase 5 (reviewers stop expanding). #3 hedging on documented fact → Phase 3 (ضمان=مضمون) + Phase 5 (stop re-voicing into a hedge) + Phase 2 (safety core keeps confident answering). NOTE: no imitation/example system — the bot follows the prompt + dashboard, per owner decision. ✔
- **Safety preservation (pre-mortem):** identity/no-invention/clarify/answer-all/no-repeat kept in `safetyCore` (Phase 2) + locked by Phase 6.1. Pass-through gated on a clean deterministic guard (Phase 5). Brevity via the dashboard setting, not truncation games (Phase 4). Thin-merchant branch covered (Phase 6.1 second test). ✔
- **No production risk:** every behavior change is flag-gated default OFF; legacy path byte-identical; merge only after staging eval. ✔
- **Placeholders:** none — every code step has real code. ✔
- **Type consistency:** `resolveSampling`, `scaledMaxLength`, `safetyCore`/`knowledgeRulesLegacy`, flag names (`AI_SAMPLING_PENALTIES_ENABLED`, `PROMPT_STYLE_SPLIT_ENABLED`, `BREVITY_AUTHORITY_ENABLED`, `REVIEW_PASSTHROUGH_ENABLED`) consistent across tasks. ✔
```
