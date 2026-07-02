# WhatsApp Config-Edit Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the merchant edit products, instant replies, and do-not-reply numbers from the escalation group with a natural command — routed by AI, applied deterministically to the structured config, behind the existing two-step confirmation.

**Architecture:** Extend the existing prompt-edit flow. A new `AIClient.planConfigEdit` classifies a command into a structured operation for one of {products, instant_replies, do_not_reply} (or falls back to the unchanged prompt path). Pure appliers in `lib/config-edit-appliers.js` compute the new section value deterministically. The pending row is generalized with `target` + `proposed_value`; on confirm, the prompt path stays byte-for-byte the same, and structured targets are written to their config field via `applySectionValue`. Lowest-risk: if classification fails or returns `prompt`, behavior is exactly today's.

**Tech Stack:** Node.js (`node:test`), PostgreSQL (`pg`, JSONB `jsonb_set`), existing `AIClient`, BullMQ outgoing queue.

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|------------|
| `lib/prompt-edit-keywords.js` | Add natural action verbs to `EDIT_KEYWORDS` | Modify |
| `lib/config-edit-appliers.js` | Pure appliers: products / instant replies / do-not-reply (match, validate, normalize) | Create |
| `lib/ai-client.js` | Add `planConfigEdit(config, request)` — classify + plan (small robust JSON) | Modify |
| `src/db/migrations/init.js` | Add `target`, `proposed_value` columns to `prompt_edit_requests` | Modify |
| `src/services/prompt-edit/prompt-edit.service.js` | Store/read target+value; `applySectionValue`; route structured targets; keep prompt path unchanged | Modify |
| `tests/config-edit-appliers.test.js` | Unit tests for appliers | Create |
| `tests/ai-client-plan-config-edit.test.js` | `planConfigEdit` parsing/validation | Create |
| `tests/prompt-edit-structured-schema.test.js` | Migration has the new columns | Create |
| `tests/prompt-edit-structured-service.test.js` | Service routing/apply per target | Create |
| `tests/prompt-edit-structured-ingest.test.js` | End-to-end via ingest, not sent to customer | Create |

Run all with `npm test`; single file with `node --test tests/<file>`.

---

## Task 1: Expand command keywords with natural action verbs

**Files:**
- Modify: `lib/prompt-edit-keywords.js:40`
- Test: `tests/prompt-edit-keywords.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/prompt-edit-keywords.test.js`:

```javascript
test('detectEditCommand recognizes natural action verbs for structured edits', () => {
  assert.equal(detectEditCommand('غيّر سعر القلم إلى ٩٩').matched, true);
  assert.equal(detectEditCommand('احذف منتج القلم').matched, true);
  assert.equal(detectEditCommand('احظر الرقم 0501234567').matched, true);
  assert.equal(detectEditCommand('شيل الحظر عن 0501234567').matched, true);
  assert.equal(detectEditCommand('امسح الرد الفوري الدوام').matched, true);
  // still not matched for unrelated chatter
  assert.equal(detectEditCommand('صباح الخير').matched, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-keywords.test.js`
Expected: FAIL — new verbs not in `EDIT_KEYWORDS`.

- [ ] **Step 3: Write minimal implementation**

In `lib/prompt-edit-keywords.js`, replace the `EDIT_KEYWORDS` line (currently line 40):

```javascript
const EDIT_KEYWORDS = ['تعديل', 'عدل', 'برومنت', 'البرومنت', 'ضيف', 'اضف',
  'غير', 'غيّر', 'احذف', 'احظر', 'شيل', 'امسح', 'حظر'].map(normalizeArabic);
```

> `normalizeArabic` strips tashkeel, so `غيّر`→`غير` (both listed are fine; dedup not required).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-keywords.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/prompt-edit-keywords.js tests/prompt-edit-keywords.test.js
git commit -m "feat(config-edit): recognize natural action verbs (غيّر/احذف/احظر/شيل/امسح)"
```

---

## Task 2: Pure appliers for the three structured sections

**Files:**
- Create: `lib/config-edit-appliers.js`
- Test: `tests/config-edit-appliers.test.js`

Contract: each applier takes the CURRENT section value + a plan `op`, and returns exactly one of:
- `{ value, summary }` — the new full section value + a one-line Arabic summary.
- `{ error }` — validation failure message (Arabic).
- `{ needsClarify }` — ambiguity/not-found question (Arabic).

- [ ] **Step 1: Write the failing test**

Create `tests/config-edit-appliers.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyProductOp,
  applyInstantReplyOp,
  applyDoNotReplyOp,
} = require('../lib/config-edit-appliers');

const PRODUCTS = [
  { name: 'اشتراك أدوبي', price: '80' },
  { name: 'كانفا برو', price: '40', description: 'تصميم' },
];

test('applyProductOp add appends a new product (name required)', () => {
  const r = applyProductOp(PRODUCTS, { action: 'add', product: { name: 'أوفيس', price: '30' } });
  assert.equal(r.value.length, 3);
  assert.deepEqual(r.value[2], { name: 'أوفيس', price: '30' });
  assert.equal(applyProductOp(PRODUCTS, { action: 'add', product: { name: '' } }).error !== undefined, true);
});

test('applyProductOp update merges only provided fields, keeps the rest', () => {
  const r = applyProductOp(PRODUCTS, { action: 'update', product: { name: 'كانفا برو', price: '55' } });
  const canva = r.value.find(p => p.name === 'كانفا برو');
  assert.equal(canva.price, '55', 'price updated');
  assert.equal(canva.description, 'تصميم', 'other fields preserved');
});

test('applyProductOp update/delete on a missing product asks for clarification', () => {
  assert.ok(applyProductOp(PRODUCTS, { action: 'update', product: { name: 'منتج وهمي', price: '9' } }).needsClarify);
  assert.ok(applyProductOp(PRODUCTS, { action: 'delete', product: { name: 'منتج وهمي' } }).needsClarify);
});

test('applyProductOp delete removes the matched product', () => {
  const r = applyProductOp(PRODUCTS, { action: 'delete', product: { name: 'اشتراك أدوبي' } });
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].name, 'كانفا برو');
});

test('applyProductOp update replaces variants when provided', () => {
  const r = applyProductOp(PRODUCTS, { action: 'update', product: { name: 'اشتراك أدوبي', variants: [{ label: 'شهر', price: '30' }, { label: 'سنة', price: '250' }] } });
  const adobe = r.value.find(p => p.name === 'اشتراك أدوبي');
  assert.equal(adobe.variants.length, 2);
  assert.equal(adobe.variants[1].price, '250');
});

test('applyInstantReplyOp add/update sets the key; delete removes it', () => {
  const add = applyInstantReplyOp({}, { action: 'add', keyword: 'الدوام', reply: 'من ٩ لـ٩' });
  assert.equal(add.value['الدوام'], 'من ٩ لـ٩');
  const del = applyInstantReplyOp({ 'الدوام': 'x' }, { action: 'delete', keyword: 'الدوام' });
  assert.equal(del.value['الدوام'], undefined);
  assert.ok(applyInstantReplyOp({}, { action: 'add', keyword: 'x', reply: '' }).error);
  assert.ok(applyInstantReplyOp({}, { action: 'delete', keyword: 'مو موجود' }).needsClarify);
});

test('applyDoNotReplyOp add normalizes + dedupes; delete removes by normalized number', () => {
  const add = applyDoNotReplyOp([], { action: 'add', number: '0501234567', name: 'مزعج' });
  assert.equal(add.value.length, 1);
  assert.equal(add.value[0].number, '0501234567');
  // same number in a different format is a duplicate (noop, no second entry)
  const dup = applyDoNotReplyOp(add.value, { action: 'add', number: '+966501234567' });
  assert.equal(dup.value.length, 1);
  const del = applyDoNotReplyOp(add.value, { action: 'delete', number: '966501234567' });
  assert.equal(del.value.length, 0);
  assert.ok(applyDoNotReplyOp([], { action: 'add', number: 'abc' }).error);
  assert.ok(applyDoNotReplyOp([], { action: 'delete', number: '0509999999' }).needsClarify);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-edit-appliers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/config-edit-appliers.js`:

```javascript
'use strict';

const { normalizeArabic } = require('./prompt-edit-keywords');
const { normalizeNumber } = require('../src/services/whatsapp/do-not-reply');

function cleanVariants(variants) {
  if (!Array.isArray(variants)) return null;
  const out = variants
    .map((v) => ({ label: String(v && v.label || '').trim(), price: String(v && v.price || '').trim() }))
    .filter((v) => v.label || v.price);
  return out.length ? out : null;
}

function findProductIndex(products, rawName) {
  const target = normalizeArabic(rawName);
  if (!target) return -1;
  let idx = products.findIndex((p) => normalizeArabic(p && p.name) === target);
  if (idx >= 0) return idx;
  return products.findIndex((p) => {
    const n = normalizeArabic(p && p.name);
    return n && (n.includes(target) || target.includes(n));
  });
}

function applyProductOp(products, op) {
  const list = Array.isArray(products) ? products.map((p) => ({ ...p })) : [];
  const p = (op && op.product) || {};
  const name = String(p.name || '').trim();
  const action = op && op.action;

  if (action === 'add') {
    if (!name) return { error: 'اسم المنتج مطلوب لإضافته.' };
    const prod = { name };
    if (p.description) prod.description = String(p.description).trim();
    if (p.price) prod.price = String(p.price).trim();
    if (p.url) prod.url = String(p.url).trim();
    if (p.longDescription) prod.longDescription = String(p.longDescription).trim();
    const variants = cleanVariants(p.variants);
    if (variants) prod.variants = variants;
    list.push(prod);
    return { value: list, summary: op.summary || `إضافة منتج: ${name}` };
  }

  const idx = findProductIndex(list, name);
  if (idx < 0) return { needsClarify: `ما لقيت منتج بالاسم "${name}". تبي تضيفه جديد؟ أرسل: أضف منتج ${name} …` };

  if (action === 'delete') {
    const removed = list.splice(idx, 1)[0];
    return { value: list, summary: op.summary || `حذف منتج: ${removed.name}` };
  }

  if (action === 'update') {
    const cur = list[idx];
    if (p.price !== undefined && p.price !== null && String(p.price).trim()) cur.price = String(p.price).trim();
    if (p.description) cur.description = String(p.description).trim();
    if (p.url) cur.url = String(p.url).trim();
    if (p.longDescription) cur.longDescription = String(p.longDescription).trim();
    const variants = cleanVariants(p.variants);
    if (variants) cur.variants = variants;
    return { value: list, summary: op.summary || `تعديل منتج: ${cur.name}` };
  }

  return { error: 'عملية غير معروفة على المنتجات.' };
}

function applyInstantReplyOp(map, op) {
  const out = { ...(map && typeof map === 'object' && !Array.isArray(map) ? map : {}) };
  const kw = String(op && op.keyword || '').trim();
  if (!kw) return { error: 'كلمة الرد الفوري مطلوبة.' };

  if (op.action === 'delete') {
    const norm = normalizeArabic(kw);
    const key = Object.keys(out).find((k) => normalizeArabic(k) === norm);
    if (!key) return { needsClarify: `ما لقيت رد فوري للكلمة "${kw}".` };
    delete out[key];
    return { value: out, summary: op.summary || `حذف الرد الفوري: ${kw}` };
  }

  const reply = String(op.reply || '').trim();
  if (!reply) return { error: 'نص الرد الفوري مطلوب.' };
  out[kw] = reply;
  return { value: out, summary: op.summary || `ضبط رد فوري للكلمة: ${kw}` };
}

function applyDoNotReplyOp(list, op) {
  const arr = Array.isArray(list) ? list.map((x) => ({ ...x })) : [];
  const num = String(op && op.number || '').trim();
  const norm = normalizeNumber(num);
  if (!norm || norm.length < 6) return { error: 'الرقم غير صالح — أرسل رقم جوال صحيح.' };

  if (op.action === 'delete') {
    const kept = arr.filter((e) => normalizeNumber(e.number) !== norm);
    if (kept.length === arr.length) return { needsClarify: `الرقم "${num}" مو موجود في قائمة الحظر.` };
    return { value: kept, summary: op.summary || `إزالة الحظر عن: ${num}` };
  }

  if (arr.some((e) => normalizeNumber(e.number) === norm)) {
    return { value: arr, summary: `الرقم محظور مسبقاً: ${num}` };
  }
  arr.push({ number: num, name: String(op.name || '').trim() });
  return { value: arr, summary: op.summary || `حظر الرقم: ${num}` };
}

module.exports = { applyProductOp, applyInstantReplyOp, applyDoNotReplyOp, findProductIndex };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config-edit-appliers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config-edit-appliers.js tests/config-edit-appliers.test.js
git commit -m "feat(config-edit): pure appliers for products/instant-replies/do-not-reply"
```

---

## Task 3: `AIClient.planConfigEdit`

**Files:**
- Modify: `lib/ai-client.js` (add method after `classifyReplyIntent`)
- Test: `tests/ai-client-plan-config-edit.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/ai-client-plan-config-edit.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
function clientReturning(content) {
  return { openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } }, model: 'gpt-4o' };
}
const CONFIG = { products: [{ name: 'اشتراك أدوبي', price: '80' }], autoReplyKeywords: { 'الدوام': 'x' }, doNotReplyList: [] };

test('planConfigEdit parses a product-update plan', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({
    target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99',
  }));
  const plan = await ai.planConfigEdit(CONFIG, 'غيّر سعر أدوبي إلى 99');
  assert.equal(plan.target, 'products');
  assert.equal(plan.action, 'update');
  assert.equal(plan.product.price, '99');
});

test('planConfigEdit parses a do-not-reply add and tolerates ```json fences', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning('```json\n{"target":"do_not_reply","action":"add","number":"0501234567","summary":"حظر"}\n```');
  const plan = await ai.planConfigEdit(CONFIG, 'احظر 0501234567');
  assert.equal(plan.target, 'do_not_reply');
  assert.equal(plan.number, '0501234567');
});

test('planConfigEdit returns a clarify field when the model is unsure', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({ target: 'products', action: 'update', clarify: 'أي منتج تقصد؟' }));
  const plan = await ai.planConfigEdit(CONFIG, 'غيّر السعر');
  assert.equal(plan.clarify, 'أي منتج تقصد؟');
});

test('planConfigEdit returns null on unparseable output or unknown target', async () => {
  const ai = new AIClient(CONFIG, silentLogger);
  ai.buildClient = () => clientReturning('مالها علاقة');
  assert.equal(await ai.planConfigEdit(CONFIG, 'xx'), null);
  ai.buildClient = () => clientReturning(JSON.stringify({ target: 'unknown', action: 'add' }));
  assert.equal(await ai.planConfigEdit(CONFIG, 'xx'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-client-plan-config-edit.test.js`
Expected: FAIL — `planConfigEdit is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/ai-client.js`, add this method immediately after the `classifyReplyIntent` method (before `proposePromptEdit`):

```javascript
  // Classifies a natural edit command into a structured operation for a config
  // section. Returns the parsed plan object, or null when the target is not one
  // of the known sections or the reply can't be parsed (caller then falls back
  // to the prompt path — today's behavior). Payloads are SMALL values, so JSON
  // here is safe (unlike the full instructions, which use proposePromptEdit).
  async planConfigEdit(config, request) {
    let openai, model;
    try { ({ openai, model } = this.buildClient()); } catch (_) { return null; }
    const productNames = (Array.isArray(config?.products) ? config.products : [])
      .map((p) => String(p && p.name || '').trim()).filter(Boolean);
    const replyKeys = config?.autoReplyKeywords && typeof config.autoReplyKeywords === 'object'
      ? Object.keys(config.autoReplyKeywords) : [];
    const system = [
      'أنت مساعد يحوّل أمر التاجر الطبيعي إلى عملية على إعدادات متجره. أعد JSON فقط.',
      'الأقسام (target): "products" أو "instant_replies" أو "do_not_reply" أو "prompt" (لو كان الطلب تعليمات عامة للبوت وليس بيانات منظّمة).',
      'العملية (action): "add" أو "update" أو "delete".',
      'الشكل:',
      '{"target":"...","action":"...","summary":"<عربي سطر واحد>","clarify":"<سؤال لو غير متأكد أي منتج/عنصر — اختياري>",',
      ' "product":{"name":"","price":"","description":"","url":"","longDescription":"","variants":[{"label":"","price":""}]},',
      ' "keyword":"","reply":"","number":"","name":""}',
      'لِـ products: طابق اسم المنتج مع القائمة أدناه واستخدم الاسم المطابق بالضبط في product.name. لو مو موجود أو غير واضح أي منتج، عبّئ "clarify".',
      'ضع الحقول ذات الصلة فقط. لا تخترع بيانات.',
      `المنتجات الحالية: ${productNames.join(' | ') || '(لا يوجد)'}`,
      `كلمات الردود الفورية الحالية: ${replyKeys.join(' | ') || '(لا يوجد)'}`,
    ].join('\n');
    let raw;
    try {
      const res = await openai.chat.completions.create({
        model, max_tokens: 500, temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: String(request || '') }],
      }, { timeout: 20000 });
      raw = res.choices?.[0]?.message?.content || '';
    } catch (_) { return null; }

    const plan = this._parsePromptEditJson(raw);
    const targets = ['products', 'instant_replies', 'do_not_reply', 'prompt'];
    if (!plan || !targets.includes(plan.target)) return null;
    return plan;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-client-plan-config-edit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai-client.js tests/ai-client-plan-config-edit.test.js
git commit -m "feat(config-edit): AIClient.planConfigEdit classifier"
```

---

## Task 4: Migration — `target` + `proposed_value` on `prompt_edit_requests`

**Files:**
- Modify: `src/db/migrations/init.js` (after the `idx_prompt_edits_user_status` index, ~line 381)
- Test: `tests/prompt-edit-structured-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-structured-schema.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('prompt_edit_requests gains target + proposed_value columns (idempotent)', () => {
  assert.match(src, /ALTER TABLE prompt_edit_requests\s+ADD COLUMN IF NOT EXISTS target TEXT/);
  assert.match(src, /ALTER TABLE prompt_edit_requests\s+ADD COLUMN IF NOT EXISTS proposed_value JSONB/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-structured-schema.test.js`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `src/db/migrations/init.js`, right after the `idx_prompt_edits_user_status` index statement (line 381), add two statements to the array:

```javascript
  `ALTER TABLE prompt_edit_requests ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'prompt'`,
  `ALTER TABLE prompt_edit_requests ADD COLUMN IF NOT EXISTS proposed_value JSONB`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-structured-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/init.js tests/prompt-edit-structured-schema.test.js
git commit -m "feat(config-edit): prompt_edit_requests target + proposed_value columns"
```

---

## Task 5: Service — store/read target+value, generic apply, route structured targets

**Files:**
- Modify: `src/services/prompt-edit/prompt-edit.service.js`
- Test: `tests/prompt-edit-structured-service.test.js`

**Design (low-risk):** the prompt path is unchanged. `insertPending` gains optional `target`/`proposedValue`. `findPendingEdit` selects them. `applyPending` routes: `prompt` → existing `applyInstructions(proposed_instructions)`; else → `applySectionValue(field, proposed_value)`. In `tryHandle`, after a command with a body, call `planConfigEdit`; if it returns a non-prompt target, run the applier and propose a structured edit; otherwise fall through to the existing prompt flow.

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-structured-service.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363@g.us';
const CONFIG = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  products: [{ name: 'اشتراك أدوبي', price: '80', description: 'تصميم' }],
  autoReplyKeywords: {},
  doNotReplyList: [],
};

function fakeDb() {
  const writes = [];
  return {
    writes,
    isConfigured: () => true,
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config: CONFIG }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/status = 'pending'/.test(sql)) return { rows: [] };
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      return { rows: [] };
    },
  };
}

function deps(planObj, over = {}) {
  const sent = [];
  return {
    sent,
    d: {
      database: over.database || fakeDb(),
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => ({
        planConfigEdit: async () => planObj,
        proposePromptEdit: async () => ({ newInstructions: 'x', summary: 'y' }),
        classifyReplyIntent: async () => 'other',
      }),
      now: () => 1_000_000,
      ttlMinutes: 10,
    },
  };
}

test('a product-price command stores a pending edit with target=products and the new products value', async () => {
  const db = fakeDb();
  const { sent, d } = deps({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99' }, { database: db });
  const res = await svc.tryHandle({ ...d, database: db, userId: 'u1', msg: { from: GROUP, body: 'غيّر سعر أدوبي إلى 99' } });
  assert.equal(res.promptEdit, 'proposed');
  const ins = db.writes.find((w) => /INSERT INTO prompt_edit_requests/.test(w.sql));
  assert.ok(ins, 'pending inserted');
  // params: (...proposed_instructions, change_summary, status? , target, proposed_value)
  assert.ok(ins.params.includes('products'), 'target=products stored');
  const pv = ins.params.find((x) => typeof x === 'string' && x.includes('"price":"99"'));
  assert.ok(pv, 'proposed_value contains the updated price');
  assert.match(sent[0].reply, /تحديث سعر أدوبي/);
});

test('a clarify plan asks the merchant and stores no pending', async () => {
  const db = fakeDb();
  const { sent, d } = deps({ target: 'products', action: 'update', clarify: 'أي منتج تقصد؟' }, { database: db });
  const res = await svc.tryHandle({ ...d, database: db, userId: 'u1', msg: { from: GROUP, body: 'غيّر السعر' } });
  assert.equal(res.promptEdit, 'clarify');
  assert.ok(!db.writes.some((w) => /INSERT INTO prompt_edit_requests/.test(w.sql)));
  assert.match(sent[0].reply, /أي منتج/);
});

test('an applier validation error is reported, no pending', async () => {
  const db = fakeDb();
  const { sent, d } = deps({ target: 'do_not_reply', action: 'add', number: 'abc' }, { database: db });
  const res = await svc.tryHandle({ ...d, database: db, userId: 'u1', msg: { from: GROUP, body: 'احظر abc' } });
  assert.equal(res.promptEdit, 'error');
  assert.ok(!db.writes.some((w) => /INSERT INTO prompt_edit_requests/.test(w.sql)));
});

test('confirming a structured pending writes proposed_value to the target field', async () => {
  const applied = [];
  const db = {
    isConfigured: () => true,
    query: async (sql, params) => {
      applied.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config: CONFIG }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/status = 'pending'/.test(sql)) {
        return { rows: [{ id: 'pe-1', target: 'products', proposed_value: [{ name: 'اشتراك أدوبي', price: '99' }], proposed_instructions: 'تحديث', change_summary: 'تحديث سعر', created_at: new Date(1_000_000).toISOString() }] };
      }
      return { rows: [] };
    },
  };
  const { d } = deps(null, { database: db });
  const res = await svc.tryHandle({ ...d, database: db, userId: 'u1', msg: { from: GROUP, body: 'نعم' } });
  assert.equal(res.promptEdit, 'applied');
  const upd = applied.find((w) => /UPDATE bot_configs/.test(w.sql));
  assert.ok(upd, 'config updated');
  assert.ok(upd.params.some((x) => typeof x === 'string' && x.includes('{products}')), 'wrote to the products field');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-structured-service.test.js`
Expected: FAIL — structured routing not implemented.

- [ ] **Step 3: Write minimal implementation**

Edit `src/services/prompt-edit/prompt-edit.service.js`:

**(a)** Add requires at the top (after the existing `require` lines):

```javascript
const { applyProductOp, applyInstantReplyOp, applyDoNotReplyOp } = require('../../../lib/config-edit-appliers');

const TARGET_FIELD = { prompt: 'botInstructions', products: 'products', instant_replies: 'autoReplyKeywords', do_not_reply: 'doNotReplyList' };
const APPLIERS = { products: applyProductOp, instant_replies: applyInstantReplyOp, do_not_reply: applyDoNotReplyOp };
const APPLIED_MSG = { prompt: '✅ تم تعديل البرومنت. أمشي عليه من الحين.', products: '✅ تم تحديث المنتجات.', instant_replies: '✅ تم تحديث الردود الفورية.', do_not_reply: '✅ تم تحديث قائمة الأرقام المحظورة.' };
```

**(b)** Generalize the persisted-write helper. Replace `applyInstructions` (currently ~line 104) with BOTH the old (kept for the prompt path) and a generic one:

```javascript
async function applyInstructions(database, userId, newInstructions) {
  return applySectionValue(database, userId, 'botInstructions', String(newInstructions || ''));
}

async function applySectionValue(database, userId, field, value) {
  await database.query(
    `UPDATE bot_configs
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), $2::text[], $3::jsonb, true),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, `{${field}}`, JSON.stringify(value)],
  );
}
```

**(c)** `insertPending` — add `target` + `proposedValue`:

```javascript
async function insertPending(database, row) {
  const r = await database.query(
    `INSERT INTO prompt_edit_requests
       (user_id, source_jid, requester_jid, request_text, current_instructions, proposed_instructions, change_summary, status, target, proposed_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9::jsonb)
     RETURNING id`,
    [row.userId, row.sourceJid, row.requesterJid, row.requestText, row.currentInstructions,
     row.proposedInstructions, row.changeSummary, row.target || 'prompt',
     row.proposedValue === undefined ? null : JSON.stringify(row.proposedValue)],
  );
  return r?.rows?.[0]?.id || null;
}
```

**(d)** `findPendingEdit` — select the new columns. Change its SELECT to:

```javascript
    `SELECT id, proposed_instructions, change_summary, created_at, target, proposed_value
       FROM prompt_edit_requests
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
```

**(e)** In `tryHandle`, replace the `applyPending` closure so it routes by target:

```javascript
  const applyPending = async () => {
    const target = pending.target || 'prompt';
    if (target === 'prompt') {
      await applyInstructions(database, userId, pending.proposed_instructions);
    } else {
      await applySectionValue(database, userId, TARGET_FIELD[target], pending.proposed_value);
    }
    await markStatus(database, pending.id, 'applied');
    await send(enqueue, userId, groupJid, APPLIED_MSG[target] || '✅ تم الحفظ.');
    logger?.info?.('prompt-edit', `applied ${target} edit ${pending.id} for ${userId}`);
    return { accepted: true, statusCode: 200, promptEdit: 'applied' };
  };
```

**(f)** In `tryHandle`, after the `if (!body) { ...help... }` block and BEFORE the existing `let proposal; try { ... proposePromptEdit ... }`, insert the structured branch:

```javascript
  // Try to classify the command into a structured section edit. If it maps to a
  // non-prompt target, handle it here; otherwise fall through to the prompt path
  // (unchanged behavior — also the safe fallback when classification fails).
  let plan = null;
  try {
    const ai = await buildAiClient(userId);
    plan = await ai.planConfigEdit(config, body);
  } catch (err) {
    logger?.warn?.('prompt-edit', `planConfigEdit failed: ${err.message}`);
  }

  if (plan && plan.target && plan.target !== 'prompt') {
    if (plan.clarify) {
      await send(enqueue, userId, groupJid, String(plan.clarify));
      return { accepted: true, statusCode: 200, promptEdit: 'clarify' };
    }
    const applier = APPLIERS[plan.target];
    const field = TARGET_FIELD[plan.target];
    const result = applier(config[field], plan);
    if (result.error) {
      await send(enqueue, userId, groupJid, `⚠️ ${result.error}`);
      return { accepted: true, statusCode: 200, promptEdit: 'error' };
    }
    if (result.needsClarify) {
      await send(enqueue, userId, groupJid, result.needsClarify);
      return { accepted: true, statusCode: 200, promptEdit: 'clarify' };
    }
    await expireGroupPendings(database, userId, groupJid);
    await insertPending(database, {
      userId, sourceJid: groupJid, requesterJid: msg.author || msg.from || null,
      requestText: body, currentInstructions: '', proposedInstructions: result.summary,
      changeSummary: result.summary, target: plan.target, proposedValue: result.value,
    });
    await send(enqueue, userId, groupJid, [
      '📝 فهمت التعديل:', `• ${result.summary}`,
      'أأكّد التطبيق؟ رد بـ (نعم) للتطبيق أو (لا) للإلغاء.',
    ].join('\n'));
    return { accepted: true, statusCode: 200, promptEdit: 'proposed' };
  }
```

> The existing prompt block that follows (`let proposal; ... proposePromptEdit ...`) is unchanged; it now also passes `target: 'prompt'` to `insertPending` — update that existing `insertPending(...)` call to add `target: 'prompt'` (and it keeps `proposedInstructions: proposal.newInstructions`).

Update the existing prompt `insertPending` call to include the target:

```javascript
  await insertPending(database, {
    userId,
    sourceJid: groupJid,
    requesterJid: msg.author || msg.from || null,
    requestText: body,
    currentInstructions: config.botInstructions || '',
    proposedInstructions: proposal.newInstructions,
    changeSummary: proposal.summary,
    target: 'prompt',
  });
```

**(g)** Export `applySectionValue` (add to `module.exports`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-structured-service.test.js tests/prompt-edit-service.test.js tests/prompt-edit-e2e.test.js`
Expected: PASS (new structured tests + all existing prompt tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/services/prompt-edit/prompt-edit.service.js tests/prompt-edit-structured-service.test.js
git commit -m "feat(config-edit): route structured edits + generic section apply (prompt path unchanged)"
```

---

## Task 6: End-to-end via ingest (real service, not sent to customer)

**Files:**
- Test: `tests/prompt-edit-structured-ingest.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-structured-ingest.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';
const CONFIG = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  products: [{ name: 'اشتراك أدوبي', price: '80' }],
  autoReplyKeywords: {}, doNotReplyList: [],
};

function statefulDb() {
  let config = { ...CONFIG };
  const edits = [];
  let seq = 0;
  return {
    get config() { return config; },
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        const p = edits.filter((e) => e.status === 'pending').slice(-1);
        return { rows: p };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        edits.push({ id: `pe-${++seq}`, status: 'pending', target: params[7], proposed_value: params[8] ? JSON.parse(params[8]) : null, proposed_instructions: params[5], change_summary: params[6], created_at: new Date(Date.now() + seq).toISOString() });
        return { rows: [{ id: `pe-${seq}` }] };
      }
      if (/UPDATE prompt_edit_requests SET status = \$2/.test(sql)) {
        const row = edits.find((e) => e.id === params[0]); if (row) row.status = params[1];
        return { rows: [{ id: params[0] }] };
      }
      if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) return { rows: [] };
      if (/UPDATE bot_configs/.test(sql)) {
        // params: [userId, '{field}', jsonValue]
        const field = String(params[1]).replace(/[{}]/g, '');
        config = { ...config, [field]: JSON.parse(params[2]) };
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}
const bridge = {
  findThreadByQuotedId: async () => null, findActiveThreadForCustomer: async () => null,
  isThreadStatusQuery: () => false, buildThreadStatusReply: async () => '',
  forwardCustomerReplyToTeam: async () => ({ forwarded: true }), relayResolutionToCustomer: async () => ({ relayed: true }),
};

test('FULL: "غيّر سعر أدوبي إلى 99" -> confirm -> products actually updated, never sent to customer', async () => {
  const db = statefulDb();
  const sent = []; let aiEnqueued = 0;
  const service = new MessageIngestService({
    database: db, logger: silentLogger, bridge,
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    enqueueOutgoing: async (p) => { sent.push(p); },
    buildPromptEditAiClient: async () => ({
      planConfigEdit: async () => ({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99' }),
      proposePromptEdit: async () => ({ newInstructions: 'x', summary: 'y' }),
      classifyReplyIntent: async () => 'other',
    }),
  });

  const r1 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'P1' }, from: GROUP, fromMe: false, body: 'غيّر سعر أدوبي إلى 99' }, source: 'baileys' });
  assert.equal(r1.promptEdit, 'proposed');
  assert.equal(aiEnqueued, 0);

  const r2 = await service.ingestWhatsappMessage({ userId: 'u1', msg: { id: { id: 'P2' }, from: GROUP, fromMe: false, body: 'نعم' }, source: 'baileys' });
  assert.equal(r2.promptEdit, 'applied');
  const adobe = db.config.products.find((p) => p.name === 'اشتراك أدوبي');
  assert.equal(adobe.price, '99', 'price really updated in products');
  assert.equal(aiEnqueued, 0, 'never reached the customer AI');
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `node --test tests/prompt-edit-structured-ingest.test.js`
Expected: PASS once Task 5 is implemented (this task adds no new source; if it fails, fix Task 5 wiring). If it fails before Task 5, that is expected.

- [ ] **Step 3: Commit**

```bash
git add tests/prompt-edit-structured-ingest.test.js
git commit -m "test(config-edit): end-to-end structured product edit via ingest"
```

---

## Task 7: Full-suite verification

**Files:** none.

- [ ] **Step 1: Run the whole suite**

Run: `node --test --test-force-exit`
Expected: only the known `tests/startup-health.test.js` force-exit artifact may show; everything else passes. Confirm `# fail` is 0 aside from that artifact (verify `startup-health` passes alone: `node --test tests/startup-health.test.js`).

- [ ] **Step 2: Sanity-load modules**

Run: `node -e "require('./lib/config-edit-appliers'); require('./lib/ai-client'); require('./src/services/prompt-edit/prompt-edit.service'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test(config-edit): full suite green"
```

---

## Self-Review

**1. Spec coverage:**
- R1 unified natural command + classify → Task 3 (`planConfigEdit`) + Task 5 routing. ✓
- R2 expanded keywords → Task 1. ✓
- R3 product match + ask on ambiguity/not-found → Task 2 (`findProductIndex`, `needsClarify`) + Task 3 `clarify` + Task 5 routing. ✓
- R4 two-step confirm + any wording → reuses existing confirm/intent path; Task 5 `applyPending`. ✓
- R5 apply to real field + reflected → Task 5 `applySectionValue`; dashboard fresh-read already shipped; worker reads fresh. ✓
- R6 validation → Task 2 (`error` returns) + do-not-reply `normalizeNumber`. ✓
- R7 escalation-group only + not-sent-to-customer + fail-open → existing gating + Task 6 asserts `aiEnqueued===0`; planConfigEdit failure falls back to prompt. ✓
- R8 history → pending rows store target + summary + proposed_value. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step has full code. The one prose note (update the existing prompt `insertPending` call) includes the exact replacement block.

**3. Type consistency:** applier return shape `{ value, summary } | { error } | { needsClarify }` is consistent across Task 2 (impl), Task 5 (consumer). `planConfigEdit` returns `{ target, action, summary, clarify?, product?, keyword?, reply?, number?, name? } | null` — consistent across Task 3 and Task 5. `TARGET_FIELD`/`APPLIERS` keys match the four `target` values. `applySectionValue(database, userId, field, value)` signature consistent between definition (Task 5b) and callers (5e). Pending columns `target`/`proposed_value` consistent across Task 4 (migration), `insertPending` (5c), `findPendingEdit` (5d), `applyPending` (5e).

---

## Notes / Out of Scope
- One item per command (no bulk).
- Only products / instant replies / do-not-reply / prompt are editable via WhatsApp.
- Prompt path behavior is deliberately unchanged; classification adds one small AI call before prompt edits (acceptable).
