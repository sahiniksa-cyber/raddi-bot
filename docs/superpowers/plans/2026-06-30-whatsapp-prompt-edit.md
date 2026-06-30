# WhatsApp Prompt-Edit (via Escalation Group) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any member of the escalation group edit the bot's prompt (`config.botInstructions`) from WhatsApp by sending a keyword-prefixed message; the bot smart-merges the change, shows a summary, asks to confirm, and applies it on `نعم`.

**Architecture:** A pure keyword module detects the command and `نعم/لا` (typo-tolerant). A prompt-edit service (functions, mirroring `escalation-bridge.js`) handles group matching, the AI merge call, the pending-edit DB row, and applying the change — all dependencies injected so it is unit-testable without Postgres/Redis. It hooks into the existing `@g.us` branch of `MessageIngestService.ingestWhatsappMessage` (after the bridge, before the group drop), fail-open. A new idempotent `prompt_edit_requests` table stores pending edits + history. The dashboard gets an enable toggle and a recent-edits list.

**Tech Stack:** Node.js (`node:test`), PostgreSQL (`pg`), BullMQ queue (`enqueueOutgoingWhatsapp`), existing `AIClient` (OpenAI/Gemini/OpenRouter), vanilla dashboard HTML.

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|------------|
| `lib/prompt-edit-keywords.js` | Pure: Arabic normalize, edit-command detection (typo-tolerant), yes/no detection | Create |
| `lib/ai-client.js` | Add `proposePromptEdit(current, request)` → `{ newInstructions, summary }` | Modify |
| `src/services/prompt-edit/prompt-edit.service.js` | Group match, DB ops (pending/history), orchestration `tryHandle(...)` | Create |
| `src/db/migrations/init.js` | Add `CREATE TABLE IF NOT EXISTS prompt_edit_requests` | Modify |
| `src/services/whatsapp/message-ingest.service.js` | Wire `tryHandle` into the `@g.us` branch (fail-open) | Modify |
| `src/controllers/config.controller.js` | Add `listPromptEdits(req,res)` | Modify |
| `src/routes/config.routes.js` | Add `GET /api/prompt-edits` | Modify |
| `dashboard/index.html` | Enable toggle `pe_enabled` + recent-edits list | Modify |
| `tests/prompt-edit-keywords.test.js` | Unit tests for the pure module | Create |
| `tests/prompt-edit-service.test.js` | Unit tests for the service (fakeDb, fake AI, fake enqueue) | Create |
| `tests/prompt-edit-ingest.test.js` | Integration: group branch routing | Create |
| `tests/ai-client-propose-prompt-edit.test.js` | `proposePromptEdit` parsing with a stubbed client | Create |
| `tests/prompt-edit-schema.test.js` | Migration contains the table | Create |
| `tests/prompt-edit-dashboard.test.js` | Dashboard has the toggle + route wired | Create |

Run all tests with: `npm test`

---

## Task 1: Pure keyword/command detection module

**Files:**
- Create: `lib/prompt-edit-keywords.js`
- Test: `tests/prompt-edit-keywords.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-keywords.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeArabic,
  detectEditCommand,
  isYes,
  isNo,
} = require('../lib/prompt-edit-keywords');

test('normalizeArabic unifies alef/hamza, ta-marbuta, alef-maqsura, strips tashkeel', () => {
  assert.equal(normalizeArabic('عدّل'), 'عدل');
  assert.equal(normalizeArabic('أضِفْ'), 'اضف');
  assert.equal(normalizeArabic('  البرومنت  '), 'البرومنت');
});

test('detectEditCommand matches each keyword and returns the body', () => {
  assert.deepEqual(detectEditCommand('تعديل: أضف إننا نوصل للرياض مجاناً'),
    { matched: true, body: 'أضف إننا نوصل للرياض مجاناً' });
  assert.deepEqual(detectEditCommand('عدّل سياسة الإرجاع 7 أيام'),
    { matched: true, body: 'سياسة الإرجاع 7 أيام' });
  assert.equal(detectEditCommand('ضيف اننا نشحن لكل المدن').matched, true);
  assert.equal(detectEditCommand('برومنت غيّر اسم الموظف').matched, true);
});

test('detectEditCommand tolerates a one-letter typo in the keyword', () => {
  assert.equal(detectEditCommand('تعدي أضف معلومة').matched, true); // missing letter
  assert.equal(detectEditCommand('تعدييل أضف معلومة').matched, true); // extra letter
});

test('detectEditCommand returns matched:false with empty body for a lone keyword', () => {
  assert.deepEqual(detectEditCommand('تعديل'), { matched: true, body: '' });
});

test('detectEditCommand does NOT match an unrelated message', () => {
  assert.equal(detectEditCommand('صباح الخير يا شباب').matched, false);
  assert.equal(detectEditCommand('تم حل المشكلة للعميل').matched, false);
});

test('isYes / isNo detect Arabic confirmations and tolerate typos', () => {
  assert.equal(isYes('نعم'), true);
  assert.equal(isYes('اي'), true);
  assert.equal(isYes('تمام'), true);
  assert.equal(isYes('نعمم'), true); // typo
  assert.equal(isYes('لا'), false);
  assert.equal(isNo('لا'), true);
  assert.equal(isNo('الغاء'), true);
  assert.equal(isNo('نعم'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-keywords.test.js`
Expected: FAIL — `Cannot find module '../lib/prompt-edit-keywords'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/prompt-edit-keywords.js`:

```javascript
'use strict';

// Pure helpers: detect a prompt-edit command (typo-tolerant) and yes/no
// confirmations in Arabic. No I/O, no dependencies — trivially unit-testable.

function normalizeArabic(s) {
  return String(s || '')
    .replace(/[ً-ْ]/g, '')      // strip tashkeel/diacritics
    .replace(/ـ/g, '')               // strip tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/ء/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[n];
}

const EDIT_KEYWORDS = ['تعديل', 'عدل', 'برومنت', 'البرومنت', 'ضيف', 'اضف'].map(normalizeArabic);
const YES_WORDS = ['نعم', 'اي', 'ايه', 'تمام', 'اوكي', 'موافق', 'اكيد', 'ايوه', 'ok', 'yes'].map(normalizeArabic);
const NO_WORDS = ['لا', 'لأ', 'الغاء', 'الغ', 'كنسل', 'تراجع', 'no', 'cancel'].map(normalizeArabic);

// matches a normalized token against a word list: exact, or edit-distance <= 1
// when both tokens are at least 3 chars long (avoids over-matching tiny words).
function matchesWord(token, words) {
  for (const w of words) {
    if (token === w) return true;
    if (token.length >= 3 && w.length >= 3 && levenshtein(token, w) <= 1) return true;
  }
  return false;
}

function splitFirstToken(text) {
  const trimmed = String(text || '').trim();
  const m = trimmed.match(/^(\S+)([\s\S]*)$/);
  if (!m) return { first: '', rest: '' };
  const first = m[1].replace(/[:：،.\-_،]+$/, '');
  const rest = m[2].replace(/^[\s:：،.\-_]+/, '').trim();
  return { first, rest };
}

function detectEditCommand(text) {
  const { first, rest } = splitFirstToken(text);
  const token = normalizeArabic(first);
  if (token && matchesWord(token, EDIT_KEYWORDS)) {
    return { matched: true, body: rest };
  }
  return { matched: false, body: '' };
}

function isYes(text) {
  const { first } = splitFirstToken(text);
  return matchesWord(normalizeArabic(first), YES_WORDS);
}

function isNo(text) {
  const { first } = splitFirstToken(text);
  return matchesWord(normalizeArabic(first), NO_WORDS);
}

module.exports = { normalizeArabic, detectEditCommand, isYes, isNo, EDIT_KEYWORDS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-keywords.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/prompt-edit-keywords.js tests/prompt-edit-keywords.test.js
git commit -m "feat(prompt-edit): typo-tolerant keyword + yes/no detection"
```

---

## Task 2: `AIClient.proposePromptEdit`

**Files:**
- Modify: `lib/ai-client.js` (add method to the class, before `module.exports`)
- Test: `tests/ai-client-propose-prompt-edit.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/ai-client-propose-prompt-edit.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function clientReturning(content) {
  return {
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } },
    model: 'gpt-4o',
  };
}

test('proposePromptEdit parses a JSON object reply into {newInstructions, summary}', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning(JSON.stringify({
    newInstructions: 'التعليمات الكاملة بعد الدمج',
    summary: 'إضافة: التوصيل مجاني للرياض',
  }));
  const out = await ai.proposePromptEdit('التعليمات القديمة', 'أضف إننا نوصل للرياض مجاناً');
  assert.equal(out.newInstructions, 'التعليمات الكاملة بعد الدمج');
  assert.equal(out.summary, 'إضافة: التوصيل مجاني للرياض');
});

test('proposePromptEdit tolerates JSON wrapped in ```json fences', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning('```json\n{"newInstructions":"ن","summary":"س"}\n```');
  const out = await ai.proposePromptEdit('قديم', 'غيّر شيء');
  assert.equal(out.newInstructions, 'ن');
  assert.equal(out.summary, 'س');
});

test('proposePromptEdit throws a clear error when the model returns no usable JSON', async () => {
  const ai = new AIClient({}, silentLogger);
  ai.buildClient = () => clientReturning('عذراً لم أفهم');
  await assert.rejects(() => ai.proposePromptEdit('قديم', 'xx'), /لم أفهم التعديل|prompt edit/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ai-client-propose-prompt-edit.test.js`
Expected: FAIL — `ai.proposePromptEdit is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/ai-client.js`, add this method inside the `AIClient` class (e.g. directly after the `getReply` method's closing brace). Find the end of `getReply` and insert:

```javascript
  /**
   * Smart-merge a merchant's free-text edit request into the current bot
   * instructions. Returns { newInstructions, summary } — the full updated
   * instructions and a one-line Arabic summary of what changed. Throws a clear
   * Arabic error when the model reply can't be parsed as JSON.
   */
  async proposePromptEdit(currentInstructions, editRequest) {
    const { openai, model } = this.buildClient();
    const system = [
      'أنت محرر تعليمات بوت خدمة عملاء. مهمتك: تطبيق تعديل التاجر على التعليمات الحالية.',
      'افهم قصد التاجر (إضافة معلومة جديدة، أو تعديل سطر موجود، أو حذف شيء)،',
      'ثم أعد التعليمات الكاملة بعد التعديل مع الحفاظ على كل ما لم يُطلب تغييره كما هو.',
      'لا تخترع معلومات لم يذكرها التاجر. رتّب التعليمات بشكل واضح.',
      'أعد الرد JSON فقط بهذا الشكل بدون أي نص إضافي:',
      '{"newInstructions":"<التعليمات الكاملة بعد التعديل>","summary":"<ملخص سطر واحد بالعربي لما تغيّر>"}',
    ].join('\n');
    const user = [
      'التعليمات الحالية:',
      '"""',
      String(currentInstructions || '(لا توجد تعليمات حالية)'),
      '"""',
      '',
      'التعديل المطلوب من التاجر:',
      String(editRequest || ''),
    ].join('\n');

    const res = await openai.chat.completions.create({
      model,
      max_tokens: 1500,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, { timeout: 30000 });

    const raw = res.choices?.[0]?.message?.content || '';
    const parsed = this._parsePromptEditJson(raw);
    if (!parsed || !String(parsed.newInstructions || '').trim()) {
      throw new Error('لم أفهم التعديل (prompt edit: invalid model JSON)');
    }
    return {
      newInstructions: String(parsed.newInstructions).trim(),
      summary: String(parsed.summary || 'تم تحديث التعليمات').trim(),
    };
  }

  _parsePromptEditJson(raw) {
    const text = String(raw || '').trim();
    try { return JSON.parse(text); } catch (_) { /* try to extract */ }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fallthrough */ } }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* fallthrough */ }
    }
    return null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ai-client-propose-prompt-edit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai-client.js tests/ai-client-propose-prompt-edit.test.js
git commit -m "feat(prompt-edit): AIClient.proposePromptEdit smart-merge + JSON parse"
```

---

## Task 3: Migration — `prompt_edit_requests` table

**Files:**
- Modify: `src/db/migrations/init.js` (add a new `CREATE TABLE IF NOT EXISTS` statement alongside the others)
- Test: `tests/prompt-edit-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-schema.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('init migration creates prompt_edit_requests idempotently with the expected columns', () => {
  assert.match(src, /CREATE TABLE IF NOT EXISTS prompt_edit_requests/);
  for (const col of [
    'user_id', 'source_jid', 'requester_jid', 'request_text',
    'current_instructions', 'proposed_instructions', 'change_summary',
    'status', 'created_at', 'decided_at',
  ]) {
    assert.ok(src.includes(col), `prompt_edit_requests must define column ${col}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-schema.test.js`
Expected: FAIL — no `prompt_edit_requests` match.

- [ ] **Step 3: Write minimal implementation**

In `src/db/migrations/init.js`, find the array of `CREATE TABLE IF NOT EXISTS` template-string statements (each existing table is one backtick string in a list). Add a new entry following the exact same style as the neighbours (e.g. after the `escalation_log` table). Use this statement:

```javascript
  `CREATE TABLE IF NOT EXISTS prompt_edit_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_jid TEXT NOT NULL,
    requester_jid TEXT,
    request_text TEXT NOT NULL,
    current_instructions TEXT,
    proposed_instructions TEXT NOT NULL,
    change_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ
  )`,
```

If neighbours add indexes after the table (check the file), add this index in the same place they do:

```javascript
  `CREATE INDEX IF NOT EXISTS idx_prompt_edits_user_status
     ON prompt_edit_requests (user_id, source_jid, status, created_at DESC)`,
```

> Match the file's actual structure: if statements live in one array, append there; if they are run sequentially via separate `await client.query(...)` calls, add two matching calls. Follow the existing `gen_random_uuid()` usage — if other tables use a different UUID default in this file, copy theirs verbatim.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/init.js tests/prompt-edit-schema.test.js
git commit -m "feat(prompt-edit): prompt_edit_requests table migration"
```

---

## Task 4: Prompt-edit service — group match + DB ops + orchestration

**Files:**
- Create: `src/services/prompt-edit/prompt-edit.service.js`
- Test: `tests/prompt-edit-service.test.js`

This service is a module of functions (mirrors `escalation-bridge.js`). All I/O dependencies are passed as arguments so it is fully unit-testable.

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-service.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363111@g.us';

// Minimal fake DB that records writes and serves a scripted config + pending row.
function fakeDb({ config = {}, pending = null } = {}) {
  const writes = [];
  return {
    writes,
    isConfigured: () => true,
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/SELECT[\s\S]*FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        return { rows: pending ? [pending] : [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      if (/UPDATE prompt_edit_requests/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/UPDATE bot_configs/.test(sql)) return { rowCount: 1 };
      if (/SELECT[\s\S]*FROM prompt_edit_requests/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function fakeAi(out) {
  return { proposePromptEdit: async () => out };
}

function makeDeps(over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      database: over.database || fakeDb(),
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => over.ai || fakeAi({ newInstructions: 'الجديد الكامل', summary: 'إضافة معلومة' }),
      now: () => 1_000_000,
      ttlMinutes: 10,
      ...over.deps,
    },
  };
}

const CONFIG_WITH_GROUP = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  botInstructions: 'تعليمات حالية طويلة كفاية لتكون البرومنت كامل بدون أي مشاكل إطلاقاً ووو',
};

test('groupMatchesEscalation matches a configured group jid (suffix-insensitive)', () => {
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, GROUP), true);
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, '120363111'), true);
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, '999@g.us'), false);
  assert.equal(svc.groupMatchesEscalation({ escalationContacts: [] }, GROUP), false);
});

test('isEnabled defaults to true and respects an explicit false', () => {
  assert.equal(svc.isEnabled({}), true);
  assert.equal(svc.isEnabled({ whatsappPromptEditEnabled: false }), false);
  assert.equal(svc.isEnabled({ whatsappPromptEditEnabled: true }), true);
});

test('tryHandle: an edit command proposes a change, stores pending, replies a summary, no customer send', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({
    ...deps,
    userId: 'u1',
    msg: { from: GROUP, author: '96650@s.whatsapp.net', body: 'تعديل: أضف إننا نوصل للرياض مجاناً' },
  });
  assert.equal(res.promptEdit, 'proposed');
  assert.ok(db.writes.some(w => /INSERT INTO prompt_edit_requests/.test(w.sql)), 'pending row inserted');
  assert.equal(sent.length, 1, 'one summary message sent to the group');
  assert.equal(sent[0].sender, GROUP);
  assert.match(sent[0].reply, /إضافة معلومة/);
});

test('tryHandle: نعم with a pending edit applies it to bot_configs and confirms', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'النص النهائي', change_summary: 'تغيير', created_at: new Date(1_000_000 - 1000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'نعم' } });
  assert.equal(res.promptEdit, 'applied');
  assert.ok(db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config updated');
  assert.ok(db.writes.some(w => /UPDATE prompt_edit_requests/.test(w.sql) && w.params.includes('applied')));
  assert.match(sent[0].reply, /تم/);
});

test('tryHandle: لا with a pending edit rejects it, no config write', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'لا' } });
  assert.equal(res.promptEdit, 'rejected');
  assert.ok(!db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config NOT updated');
});

test('tryHandle: returns null for a non-command message in the group (falls through)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'صباح الخير' } });
  assert.equal(res, null);
});

test('tryHandle: returns null when feature disabled, even for an edit command', async () => {
  const db = fakeDb({ config: { ...CONFIG_WITH_GROUP, whatsappPromptEditEnabled: false } });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل: شيء' } });
  assert.equal(res, null);
});

test('tryHandle: returns null when the group is not a configured escalation group', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: '777@g.us', body: 'تعديل: شيء' } });
  assert.equal(res, null);
});

test('tryHandle: a lone keyword asks the user to write the change (handled, no AI call)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  let aiCalled = 0;
  const { sent, deps } = makeDeps({ database: db, ai: { proposePromptEdit: async () => { aiCalled++; return {}; } } });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل' } });
  assert.equal(res.promptEdit, 'help');
  assert.equal(aiCalled, 0);
  assert.match(sent[0].reply, /اكتب التعديل|بعد كلمة/);
});

test('tryHandle: model failure sends a clear error and does not store a pending row', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const failingAi = { proposePromptEdit: async () => { throw new Error('boom'); } };
  const { sent, deps } = makeDeps({ database: db, ai: failingAi });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل: شيء غامض' } });
  assert.equal(res.promptEdit, 'error');
  assert.ok(!db.writes.some(w => /INSERT INTO prompt_edit_requests/.test(w.sql)));
  assert.match(sent[0].reply, /ما قدرت أفهم|جرّب/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-service.test.js`
Expected: FAIL — `Cannot find module '.../prompt-edit.service'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/prompt-edit/prompt-edit.service.js`:

```javascript
'use strict';

const { detectEditCommand, isYes, isNo } = require('../../../lib/prompt-edit-keywords');
const { normalizeEscalationTarget } = require('../../workers/escalation-routing');

function digitsOf(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
}

// True when `jid` is one of the escalation contacts configured as a GROUP.
function groupMatchesEscalation(config, jid) {
  const target = digitsOf(jid);
  if (!target) return false;
  const contacts = Array.isArray(config?.escalationContacts) ? config.escalationContacts : [];
  for (const c of contacts) {
    const norm = normalizeEscalationTarget(c?.phone || c?.target || c?.jid);
    if (norm && norm.endsWith('@g.us') && digitsOf(norm) === target) return true;
  }
  return false;
}

function isEnabled(config) {
  return config?.whatsappPromptEditEnabled !== false; // default ON
}

async function loadConfig(database, userId) {
  const r = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
  return r?.rows?.[0]?.config || {};
}

async function findPendingEdit(database, userId, sourceJid, nowMs, ttlMinutes) {
  const r = await database.query(
    `SELECT id, proposed_instructions, change_summary, created_at
       FROM prompt_edit_requests
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, sourceJid],
  );
  const row = r?.rows?.[0];
  if (!row) return null;
  const ageMs = nowMs - new Date(row.created_at).getTime();
  if (ageMs > ttlMinutes * 60 * 1000) {
    await markStatus(database, row.id, 'expired').catch(() => {});
    return null;
  }
  return row;
}

async function expireGroupPendings(database, userId, sourceJid) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = 'expired', decided_at = NOW()
      WHERE user_id = $1 AND source_jid = $2 AND status = 'pending'`,
    [userId, sourceJid],
  );
}

async function insertPending(database, row) {
  const r = await database.query(
    `INSERT INTO prompt_edit_requests
       (user_id, source_jid, requester_jid, request_text, current_instructions, proposed_instructions, change_summary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [row.userId, row.sourceJid, row.requesterJid, row.requestText, row.currentInstructions, row.proposedInstructions, row.changeSummary],
  );
  return r?.rows?.[0]?.id || null;
}

async function markStatus(database, id, status) {
  await database.query(
    `UPDATE prompt_edit_requests SET status = $2, decided_at = NOW() WHERE id = $1`,
    [id, status],
  );
}

async function applyInstructions(database, userId, newInstructions) {
  await database.query(
    `UPDATE bot_configs
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{botInstructions}', $2::jsonb, true),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, JSON.stringify(String(newInstructions || ''))],
  );
}

async function send(enqueue, userId, groupJid, reply) {
  await enqueue({ userId, sender: groupJid, reply, source: 'prompt_edit' });
}

/**
 * Main entry. Called from the @g.us branch of message ingest. Returns a result
 * object when it handled the message (so ingest must NOT drop or relay it), or
 * null to let normal group handling continue. Never throws on model failure —
 * it reports the failure to the group and returns a handled result.
 */
async function tryHandle({ database, userId, msg, enqueue, buildAiClient, logger, now = Date.now, ttlMinutes = 10 }) {
  const groupJid = msg?.from;
  const text = String(msg?.body || '').trim();
  if (!groupJid || !String(groupJid).includes('@g.us') || !text) return null;

  const config = await loadConfig(database, userId);
  if (!isEnabled(config)) return null;
  if (!groupMatchesEscalation(config, groupJid)) return null;

  const nowMs = now();
  const pending = await findPendingEdit(database, userId, groupJid, nowMs, ttlMinutes);

  // Confirmation flow (only meaningful when a pending edit exists).
  if (pending) {
    if (isYes(text)) {
      await applyInstructions(database, userId, pending.proposed_instructions);
      await markStatus(database, pending.id, 'applied');
      await send(enqueue, userId, groupJid, '✅ تم تعديل البرومنت. أمشي عليه من الحين.');
      logger?.info?.('prompt-edit', `applied edit ${pending.id} for ${userId}`);
      return { accepted: true, statusCode: 200, promptEdit: 'applied' };
    }
    if (isNo(text)) {
      await markStatus(database, pending.id, 'rejected');
      await send(enqueue, userId, groupJid, 'تمام، ألغيت التعديل. ما غيّرت شيء.');
      return { accepted: true, statusCode: 200, promptEdit: 'rejected' };
    }
    // Neither yes nor no — fall through; maybe it's a brand-new edit command.
  }

  const { matched, body } = detectEditCommand(text);
  if (!matched) return null;

  if (!body) {
    await send(enqueue, userId, groupJid,
      'اكتب التعديل بعد كلمة "تعديل". مثال: تعديل: أضف إننا نوصّل للرياض مجاناً.');
    return { accepted: true, statusCode: 200, promptEdit: 'help' };
  }

  let proposal;
  try {
    const ai = await buildAiClient(userId);
    proposal = await ai.proposePromptEdit(config.botInstructions || '', body);
  } catch (err) {
    logger?.warn?.('prompt-edit', `model failed: ${err.message}`);
    await send(enqueue, userId, groupJid, 'ما قدرت أفهم التعديل 😅 جرّب تكتبه بصيغة أوضح.');
    return { accepted: true, statusCode: 200, promptEdit: 'error' };
  }

  await expireGroupPendings(database, userId, groupJid);
  await insertPending(database, {
    userId,
    sourceJid: groupJid,
    requesterJid: msg.author || msg.from || null,
    requestText: body,
    currentInstructions: config.botInstructions || '',
    proposedInstructions: proposal.newInstructions,
    changeSummary: proposal.summary,
  });

  const reply = [
    '📝 فهمت التعديل:',
    `• ${proposal.summary}`,
    'أأكّد التطبيق؟ رد بـ (نعم) للتطبيق أو (لا) للإلغاء.',
  ].join('\n');
  await send(enqueue, userId, groupJid, reply);
  logger?.info?.('prompt-edit', `proposed edit for ${userId} in ${groupJid}`);
  return { accepted: true, statusCode: 200, promptEdit: 'proposed' };
}

async function listRecentEdits(database, userId, limit = 10) {
  const r = await database.query(
    `SELECT id, requester_jid, change_summary, status, created_at, decided_at
       FROM prompt_edit_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return r?.rows || [];
}

module.exports = {
  tryHandle,
  groupMatchesEscalation,
  isEnabled,
  findPendingEdit,
  applyInstructions,
  listRecentEdits,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-service.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/prompt-edit/prompt-edit.service.js tests/prompt-edit-service.test.js
git commit -m "feat(prompt-edit): orchestration service (group match, pending, apply)"
```

---

## Task 5: Wire the service into the group branch of message ingest

**Files:**
- Modify: `src/services/whatsapp/message-ingest.service.js`
  - Top requires (~lines 3-5): add the prompt-edit service, the outgoing enqueue, and the AI client factory.
  - Constructor (~line 137): add injectable `promptEdit` + `buildPromptEditAiClient`.
  - `ingestWhatsappMessage` `@g.us` branch (~lines 244-251): call the handler first.
- Test: `tests/prompt-edit-ingest.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-ingest.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

const silentLogger = { info: () => {}, warn: () => {} };
const GROUP = '120363@g.us';

function fakeDb() {
  return {
    isConfigured: () => true,
    query: async () => ({ rows: [] }),
    transaction: async (fn) => fn({ query: async (sql) => {
      if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'c', phone_number: null }] };
      if (/RETURNING id/.test(sql)) return { rows: [{ id: 'm' }] };
      return { rows: [] };
    } }),
  };
}
function fakeBridge() {
  return {
    findThreadByQuotedId: async () => null,
    findActiveThreadForCustomer: async () => null,
    isThreadStatusQuery: () => false,
    buildThreadStatusReply: async () => '',
    forwardCustomerReplyToTeam: async () => ({ forwarded: true }),
    relayResolutionToCustomer: async () => ({ relayed: true }),
  };
}

test('an edit command in the group is handled by the prompt-edit service and not dropped/sent to AI', async () => {
  let aiEnqueued = 0;
  let handledMsg = null;
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => { aiEnqueued++; } },
    promptEdit: async ({ msg }) => { handledMsg = msg.body; return { accepted: true, statusCode: 200, promptEdit: 'proposed' }; },
  });

  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'E1' }, from: GROUP, fromMe: false, body: 'تعديل: أضف معلومة' },
    source: 'baileys',
  });

  assert.equal(res.promptEdit, 'proposed');
  assert.equal(aiEnqueued, 0, 'edit command never reaches the customer AI');
  assert.equal(handledMsg, 'تعديل: أضف معلومة');
});

test('a normal group message still falls through to ignore when prompt-edit returns null', async () => {
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    promptEdit: async () => null,
  });
  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G1' }, from: GROUP, fromMe: false, body: 'صباح الخير' },
    source: 'baileys',
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'ignored');
});

test('a prompt-edit handler that throws does not break ingest (fail-open to ignore)', async () => {
  const service = new MessageIngestService({
    database: fakeDb(), logger: silentLogger, bridge: fakeBridge(),
    queue: { enqueueAiReply: async () => {} },
    promptEdit: async () => { throw new Error('boom'); },
  });
  const res = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'G2' }, from: GROUP, fromMe: false, body: 'تعديل: شيء' },
    source: 'baileys',
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'ignored');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-ingest.test.js`
Expected: FAIL — the edit command falls through to `ignored` (handler not wired), `aiEnqueued`/`promptEdit` assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `src/services/whatsapp/message-ingest.service.js`:

(a) Add requires near the existing ones (after line 5):

```javascript
const promptEditService = require('../prompt-edit/prompt-edit.service');
const { enqueueOutgoingWhatsapp } = require('../../queues/message-queue');
```

(b) Add a lazy AI-client factory near the top-level helpers (after the requires, before `class`):

```javascript
// Builds an AIClient bound to a merchant's config — used by the prompt-edit
// handler to smart-merge edits. Lazy-required to avoid a heavy import on the
// hot ingest path and to keep the module load cheap for tests.
async function defaultBuildPromptEditAiClient(userId, logger) {
  const AIClient = require('../../../lib/ai-client');
  const { resolveConfigForAI } = require('../bot/runtime-bot');
  const config = await resolveConfigForAI(userId);
  return new AIClient(config, logger);
}
```

(c) In the constructor (line 137), extend the destructured options and store them:

```javascript
  constructor({ logger = console, queue = { enqueueAiReply }, database = db, bridge = escalationBridge,
                promptEdit = null, enqueueOutgoing = enqueueOutgoingWhatsapp, buildPromptEditAiClient = null } = {}) {
    this.logger = logger;
    this.queue = queue;
    this.db = database;
    this.bridge = bridge;
    this.enqueueOutgoing = enqueueOutgoing;
    this.buildPromptEditAiClient = buildPromptEditAiClient
      || ((userId) => defaultBuildPromptEditAiClient(userId, logger));
    // Injectable handler: a function ({ userId, msg }) => resultObject|null.
    // Defaults to the real service wired with this instance's deps.
    this.promptEdit = promptEdit || (({ userId, msg }) => promptEditService.tryHandle({
      database: this.db,
      userId,
      msg,
      enqueue: this.enqueueOutgoing,
      buildAiClient: this.buildPromptEditAiClient,
      logger: this.logger,
    }));
  }
```

> Keep the rest of the constructor body (anything after line 141) unchanged — only the signature line and the added assignments change.

(d) In `ingestWhatsappMessage`, inside the `@g.us` branch (currently lines 244-251), call the handler FIRST:

```javascript
    if (String(msg?.from || '').includes('@g.us')) {
      // Prompt-edit command from an escalation group (e.g. "تعديل: ..."). Runs
      // BEFORE the status query and the group drop, and is fail-open: any error
      // falls through to normal group handling so ingest never breaks.
      const editHandled = await Promise.resolve()
        .then(() => this.promptEdit({ userId, msg }))
        .catch((e) => { this.logger.warn?.('prompt-edit', `handler failed: ${e.message}`); return null; });
      if (editHandled) return editHandled;

      // No quote, but a status question inside a group that has recent
      // escalation threads ("وش صار" بدون اقتباس) — answer about the latest
      // thread instead of ignoring it (production 2026-06-12).
      const noQuoteStatus = await this.tryGroupStatusQuery({ userId, msg }).catch(() => null);
      if (noQuoteStatus) return noQuoteStatus;
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-ingest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/whatsapp/message-ingest.service.js tests/prompt-edit-ingest.test.js
git commit -m "feat(prompt-edit): wire handler into the escalation-group branch (fail-open)"
```

---

## Task 6: Read endpoint `GET /api/prompt-edits` for the dashboard log

**Files:**
- Modify: `src/controllers/config.controller.js` (add `listPromptEdits`)
- Modify: `src/routes/config.routes.js` (add the route, same auth as `GET /api/config`)
- Test: `tests/prompt-edit-dashboard.test.js` (route + dashboard source checks; see Task 7 for dashboard markup)

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-edit-dashboard.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'config.routes.js'), 'utf8');
const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'config.controller.js'), 'utf8');

test('config routes expose GET /api/prompt-edits', () => {
  assert.match(routesSrc, /get\(\s*['"]\/prompt-edits['"]/);
});

test('config controller exports listPromptEdits', () => {
  assert.match(ctrlSrc, /listPromptEdits/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-dashboard.test.js`
Expected: FAIL — neither pattern present.

- [ ] **Step 3: Write minimal implementation**

In `src/controllers/config.controller.js`, add (and include in the `module.exports`):

```javascript
const promptEditService = require('../services/prompt-edit/prompt-edit.service');
const db = require('../db/client');

async function listPromptEdits(req, res) {
  try {
    const userId = req.session.userId;
    const rows = await promptEditService.listRecentEdits(db, userId, 10);
    res.json({ success: true, edits: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: 'failed_to_list_prompt_edits' });
  }
}
```

> If `db` is already required at the top of the controller, reuse the existing import instead of adding a duplicate. Add `listPromptEdits` to the existing `module.exports = { ... }`.

In `src/routes/config.routes.js`, add the route next to `GET /api/config`, copying that route's auth middleware exactly:

```javascript
router.get('/prompt-edits', /* same auth middleware as GET '/config' */ configController.listPromptEdits);
```

> Open the file, find the `router.get('/config', ...)` line, and mirror its middleware chain (e.g. `requireAuth`) for `/prompt-edits`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-dashboard.test.js`
Expected: the route + controller tests PASS (the dashboard-markup test is added in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/config.controller.js src/routes/config.routes.js tests/prompt-edit-dashboard.test.js
git commit -m "feat(prompt-edit): GET /api/prompt-edits endpoint for the dashboard log"
```

---

## Task 7: Dashboard — enable toggle + recent-edits list (escalation section)

**Files:**
- Modify: `dashboard/index.html`
  - Add a checkbox `pe_enabled` inside the escalation settings block (near `escConditions`/`escPausesBot`, ~lines 1955-1958).
  - Load it in `fillForm` (~line 1918+) and include it in the saved `configObj` (~lines 2607-2613).
  - Add a small recent-edits panel that fetches `/api/prompt-edits`.
- Test: extend `tests/prompt-edit-dashboard.test.js`

- [ ] **Step 1: Add the failing assertions**

Append to `tests/prompt-edit-dashboard.test.js`:

```javascript
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

test('dashboard has the prompt-edit enable toggle', () => {
  assert.match(htmlSrc, /id=["']pe_enabled["']/);
});

test('dashboard saves and loads whatsappPromptEditEnabled', () => {
  assert.match(htmlSrc, /whatsappPromptEditEnabled/);
});

test('dashboard fetches the prompt-edit log endpoint', () => {
  assert.match(htmlSrc, /\/api\/prompt-edits/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-edit-dashboard.test.js`
Expected: the 3 new tests FAIL.

- [ ] **Step 3: Write minimal implementation**

(a) In the escalation settings block (near the `escPausesBot` checkbox), add:

```html
<label style="display:flex;align-items:center;gap:8px;margin-top:10px">
  <input type="checkbox" id="pe_enabled" checked>
  تعديل البرومنت من قروب التصعيد عبر الواتساب
</label>
<div id="peLog" style="margin-top:10px;font-size:13px;color:#555"></div>
```

(b) In `fillForm` (where other checkboxes are populated from `cfg`), add:

```javascript
document.getElementById('pe_enabled').checked = cfg.whatsappPromptEditEnabled !== false;
```

(c) In the save handler where `configObj` is built (near `escPausesBot`/`ownerPausePhrases`), add:

```javascript
configObj.whatsappPromptEditEnabled = document.getElementById('pe_enabled').checked;
```

(d) Add a loader for the log, and call it inside the existing post-load flow (e.g. right after `fillForm(...)` runs, or in the settings tab's init):

```javascript
async function loadPromptEditLog() {
  try {
    const r = await fetch('/api/prompt-edits', { credentials: 'same-origin' });
    const data = await r.json();
    const box = document.getElementById('peLog');
    if (!box) return;
    if (!data.success || !data.edits || !data.edits.length) { box.textContent = 'لا توجد تعديلات بعد.'; return; }
    const statusAr = { applied: '✅ تم', rejected: '❌ ملغى', pending: '⏳ بانتظار', expired: '⌛ انتهى' };
    box.innerHTML = '<b>آخر التعديلات من الواتساب:</b><br>' + data.edits.map(e =>
      `• ${(statusAr[e.status] || e.status)} — ${e.change_summary || ''} <span style="color:#999">(${new Date(e.created_at).toLocaleString('ar')})</span>`
    ).join('<br>');
  } catch (_) { /* non-fatal: log panel stays empty */ }
}
loadPromptEditLog();
```

> Match the file's existing element ids, fetch style, and indentation. If the dashboard guards calls behind a "settings tab loaded" hook, place `loadPromptEditLog()` there instead of at top level.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-edit-dashboard.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html tests/prompt-edit-dashboard.test.js
git commit -m "feat(prompt-edit): dashboard enable toggle + recent-edits log"
```

---

## Task 8: Full suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: All tests pass, including every pre-existing test (proves no regression in escalation bridge, owner-pause, ingest, ai-client). If any pre-existing test fails, STOP and fix the wiring — do not modify unrelated tests to make them pass.

- [ ] **Step 2: Lint/sanity the new files load**

Run: `node -e "require('./lib/prompt-edit-keywords'); require('./src/services/prompt-edit/prompt-edit.service'); require('./src/services/whatsapp/message-ingest.service'); console.log('modules load OK')"`
Expected: `modules load OK` (no require/syntax errors, no circular-import crash).

- [ ] **Step 3: Confirm the count**

Run: `npm test 2>&1 | tail -5`
Expected: a passing summary (e.g. `# pass <N>`, `# fail 0`). Record N.

- [ ] **Step 4: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test(prompt-edit): full suite green"
```

---

## Self-Review

**1. Spec coverage:**
- R1 (anyone in escalation group) → Task 4 `groupMatchesEscalation` + no per-sender restriction. ✓
- R2 (keyword prefix list) → Task 1 `EDIT_KEYWORDS`. ✓
- R3 (typo tolerance + normalize) → Task 1 `normalizeArabic` + `levenshtein`. ✓
- R4 (smart merge add/edit/remove) → Task 2 `proposePromptEdit`. ✓
- R5 (two-step: summary + confirm) → Task 4 propose → نعم apply. ✓
- R6 (لا cancels, TTL expires) → Task 4 `isNo` branch + `findPendingEdit` TTL. ✓
- R7 (not sent to customer) → Task 5 returns the handled result before status/drop; Task 4 only enqueues to the group jid. ✓
- R8 (history + undo data) → Task 3 table stores current+proposed; Task 4 `insertPending`/`markStatus`. ✓
- R9 (dashboard toggle + log) → Tasks 6 & 7. ✓
- Non-conflict guarantees (spec table) → Task 5 places the hook after the bridge, before the drop, fail-open; Task 3 idempotent migration; Task 8 runs the full suite. ✓

**2. Placeholder scan:** No TBD/TODO. The two "match the existing file" notes (Task 3 migration array shape, Task 6 auth middleware, Task 7 element ids) are instructions to copy verbatim from neighbouring code, with the exact statement/snippet provided — not deferred work.

**3. Type consistency:** Result contract `{ accepted, statusCode, promptEdit }` is consistent across Tasks 4 and 5. `tryHandle` signature matches its call site in Task 5. `listRecentEdits(database, userId, limit)` matches the controller call in Task 6. `proposePromptEdit(current, request) → { newInstructions, summary }` matches the service consumer in Task 4 and the test in Task 2. Field names (`newInstructions`, `summary`, `proposed_instructions`, `change_summary`) are consistent between the model method, the service, and the table columns.

---

## Notes / Out of Scope (YAGNI)
- No `تراجع` (undo) command yet — the table stores `current_instructions` so it can be added later.
- No direct-DM (رقم المصعّد 1:1) trigger — escalation group only.
- English keywords/other languages not handled.
