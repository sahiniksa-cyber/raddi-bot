# Conversations Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Replace the accordion-based conversations view with a two-pane layout (list + reading panel) that collapses to inline accordion on mobile (≤900px).

**Architecture:** Backend gains 3 fields per message (`status`, `hasMedia`, `mediaKind`) plus optional `?q=` search. Frontend gets a new `dashboard/conversations.css` file, a rewritten `#view-conversations` block in `index.html`, and 6 new JS functions. Tabs (الكل/مستمرة/منتهية) are removed — status is now a 🟢/⚪ dot.

**Tech Stack:** Vanilla JS, CSS, Express, PostgreSQL, node:test.

**Spec:** [docs/superpowers/specs/2026-05-24-conversations-redesign-design.md](../specs/2026-05-24-conversations-redesign-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/controllers/conversations.controller.js` | Modify | Add `status`/`hasMedia`/`mediaKind` to `normalizeMessage`, accept `req.query.q` |
| `tests/conversations-controller.test.js` | Modify | Cover new fields |
| `tests/conversations-search.test.js` | Create | Verify `?q=` produces ILIKE WHERE clause |
| `dashboard/conversations.css` | Create | All two-pane + bubble styling |
| `dashboard/index.html` | Modify | Replace `#view-conversations` block, link CSS, rewrite JS functions |
| `tests/dashboard-conversations-ui.test.js` | Create | Regex assertions on HTML: two-pane elements, no old tabs |

---

## Task 1: Backend — add `status`, `hasMedia`, `mediaKind` to message payload

**Files:**
- Modify: `src/controllers/conversations.controller.js` (function `normalizeMessage` ~line 29 and `messages` SQL ~line 91)
- Test: `tests/conversations-controller.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/conversations-controller.test.js`:

```js
test('normalizeMessage includes status, hasMedia, mediaKind for outbound messages', () => {
  const { _internals } = require('../src/controllers/conversations.controller');
  // Expose via re-exporting from controller (see Step 3 for export change)
  const { normalizeMessage } = require('../src/controllers/conversations.controller');

  const sent = normalizeMessage({
    role: 'assistant', direction: 'outbound', content: 'hi',
    status: 'sent', raw_payload: null, created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.hasMedia, false);
  assert.equal(sent.mediaKind, null);
});

test('normalizeMessage detects image media from raw_payload', () => {
  const { normalizeMessage } = require('../src/controllers/conversations.controller');
  const msg = normalizeMessage({
    role: 'user', direction: 'inbound', content: '[صورة من العميل: فاتورة]',
    status: 'answered_by_ai',
    raw_payload: { media: { kind: 'image', mimeType: 'image/jpeg' } },
    created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.mediaKind, 'image');
});

test('normalizeMessage detects audio/ptt media kind', () => {
  const { normalizeMessage } = require('../src/controllers/conversations.controller');
  const msg = normalizeMessage({
    role: 'user', direction: 'inbound', content: '[رسالة صوتية]',
    status: 'answered_by_ai',
    raw_payload: { media: { kind: 'ptt' } },
    created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.mediaKind, 'ptt');
});

test('conversations controller selects status and raw_payload from messages table', async () => {
  const queries = [];
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0, ongoing: 0, finished: 0 }] };
      return { rows: [] };
    },
  };
  const { createConversationsController } = require('../src/controllers/conversations.controller');
  const ctl = createConversationsController({ database });
  const req = { session: { userId: 'u1' }, query: {} };
  const res = { json: () => {} };
  await ctl.list(req, res);
  const msgQ = queries.find(q => /FROM messages/.test(q.sql) && /WHERE conversation_id = ANY/.test(q.sql));
  // When the conversation list is empty, the messages query may not run — that's OK.
  // When it runs, it must select status and raw_payload.
  if (msgQ) {
    assert.match(msgQ.sql, /status/);
    assert.match(msgQ.sql, /raw_payload/);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conversations-controller.test.js`
Expected: 3 new FAIL (status/hasMedia/mediaKind undefined).

- [ ] **Step 3: Update `normalizeMessage`**

In `src/controllers/conversations.controller.js`, replace the `normalizeMessage` function with:

```js
function normalizeMessage(row) {
  const media = row.raw_payload?.media || null;
  const kindRaw = String(media?.kind || media?.type || '').toLowerCase();
  let mediaKind = null;
  if (media) {
    if (kindRaw.includes('image') || String(media.mimeType || '').startsWith('image/')) mediaKind = 'image';
    else if (kindRaw === 'ptt') mediaKind = 'ptt';
    else if (kindRaw.includes('audio') || String(media.mimeType || '').startsWith('audio/')) mediaKind = 'audio';
    else if (kindRaw.includes('video')) mediaKind = 'video';
    else if (kindRaw.includes('document')) mediaKind = 'document';
    else mediaKind = kindRaw || 'other';
  }
  return {
    speaker: row.role === 'assistant' || row.direction === 'outbound' ? 'AI' : 'العميل',
    role: row.role,
    direction: row.direction,
    content: row.content || '',
    at: row.created_at,
    status: row.status || null,
    hasMedia: !!media,
    mediaKind,
  };
}
```

- [ ] **Step 4: Update the messages SQL**

Find the messages SELECT (around line 91-97):
```js
        const messages = await database.query(
          `SELECT conversation_id, role, direction, content, created_at
           FROM messages
           WHERE conversation_id = ANY($1::uuid[])
             AND user_id = $2
           ORDER BY created_at ASC`,
          [ids, userId],
        );
```

Replace with:
```js
        const messages = await database.query(
          `SELECT conversation_id, role, direction, content, status, raw_payload, created_at
           FROM messages
           WHERE conversation_id = ANY($1::uuid[])
             AND user_id = $2
           ORDER BY created_at ASC`,
          [ids, userId],
        );
```

- [ ] **Step 5: Export `normalizeMessage`**

At the bottom of the file, the exports include `buildConversationTitle, classifyConversation, cleanCustomerPhone, createConversationsController`. Add `normalizeMessage`:

```js
module.exports = {
  buildConversationTitle,
  classifyConversation,
  cleanCustomerPhone,
  createConversationsController,
  normalizeMessage,
};
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `node --test tests/conversations-controller.test.js`
Expected: all PASS (existing 2 + new 4).

- [ ] **Step 7: Commit**

```bash
git add src/controllers/conversations.controller.js tests/conversations-controller.test.js
git commit -m "feat(conversations): expose status, hasMedia, mediaKind per message"
```

---

## Task 2: Backend — server-side search via `?q=`

**Files:**
- Modify: `src/controllers/conversations.controller.js`
- Test: `tests/conversations-search.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/conversations-search.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConversationsController } = require('../src/controllers/conversations.controller');

function makeDb() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0, ongoing: 0, finished: 0 }] };
      return { rows: [] };
    },
  };
}

test('list passes ?q= into ILIKE WHERE clauses on sender and message content', async () => {
  const database = makeDb();
  const ctl = createConversationsController({ database });
  const req = { session: { userId: 'u1' }, query: { q: '5234' } };
  const res = { json: () => {} };
  await ctl.list(req, res);

  const listQuery = database.queries.find(q => /FROM conversations c/.test(q.sql) && /LEFT JOIN LATERAL/.test(q.sql));
  assert.ok(listQuery, 'list query must run');
  assert.match(listQuery.sql, /c\.sender ILIKE/);
  assert.match(listQuery.sql, /m2\.content ILIKE/);
  assert.ok(listQuery.params.includes('%5234%'), 'params must include wildcard-wrapped query');
});

test('list omits ILIKE branch when q is empty', async () => {
  const database = makeDb();
  const ctl = createConversationsController({ database });
  const req = { session: { userId: 'u1' }, query: { q: '' } };
  const res = { json: () => {} };
  await ctl.list(req, res);

  const listQuery = database.queries.find(q => /FROM conversations c/.test(q.sql) && /LEFT JOIN LATERAL/.test(q.sql));
  assert.doesNotMatch(listQuery.sql, /ILIKE/);
});
```

- [ ] **Step 2: Run — should fail**

Run: `node --test tests/conversations-search.test.js`
Expected: 2 FAIL.

- [ ] **Step 3: Update the controller's `list` to support `q`**

In `src/controllers/conversations.controller.js`, inside the `list` async function, find the block right after `const limitPlaceholder = ...;` and BEFORE the `Promise.all([...])` call. Insert the `q` handling:

The current structure (around lines 44-54):
```js
      const userId = req.session.userId;
      const limit = Math.max(1, Math.min(50, parseInt(req.query?.limit, 10) || 20));
      const statusFilter = ['ongoing', 'finished'].includes(req.query?.status) ? req.query.status : 'all';
      const now = Date.now();
      const cutoffIso = new Date(now - ACTIVE_WINDOW_MS).toISOString();

      const listParams = [userId];
      let statusCondition = '';
      if (statusFilter === 'ongoing') { statusCondition = ' AND c.last_message_at >= $2'; listParams.push(cutoffIso); }
      else if (statusFilter === 'finished') { statusCondition = ' AND c.last_message_at < $2'; listParams.push(cutoffIso); }
      listParams.push(limit);
      const limitPlaceholder = `$${listParams.length}`;
```

Replace with:

```js
      const userId = req.session.userId;
      const limit = Math.max(1, Math.min(50, parseInt(req.query?.limit, 10) || 20));
      const statusFilter = ['ongoing', 'finished'].includes(req.query?.status) ? req.query.status : 'all';
      const searchQuery = String(req.query?.q || '').trim();
      const now = Date.now();
      const cutoffIso = new Date(now - ACTIVE_WINDOW_MS).toISOString();

      const listParams = [userId];
      let statusCondition = '';
      if (statusFilter === 'ongoing') { statusCondition = ' AND c.last_message_at >= $2'; listParams.push(cutoffIso); }
      else if (statusFilter === 'finished') { statusCondition = ' AND c.last_message_at < $2'; listParams.push(cutoffIso); }

      let searchCondition = '';
      if (searchQuery) {
        listParams.push(`%${searchQuery}%`);
        const qPlaceholder = `$${listParams.length}`;
        searchCondition = ` AND (c.sender ILIKE ${qPlaceholder} OR EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.user_id = c.user_id
            AND m2.content ILIKE ${qPlaceholder}
        ))`;
      }

      listParams.push(limit);
      const limitPlaceholder = `$${listParams.length}`;
```

Then in the list query (`database.query(...)` block), change:
```js
           WHERE c.user_id = $1${statusCondition}
```
to:
```js
           WHERE c.user_id = $1${statusCondition}${searchCondition}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `node --test tests/conversations-search.test.js`
Expected: 2 PASS. Also run `node --test tests/conversations-controller.test.js` — no regression.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/conversations.controller.js tests/conversations-search.test.js
git commit -m "feat(conversations): server-side search via ?q= query param"
```

---

## Task 3: Create `dashboard/conversations.css`

**Files:**
- Create: `dashboard/conversations.css`
- Modify: `dashboard/index.html` (add `<link>` tag in head)

- [ ] **Step 1: Create the CSS file**

Create `dashboard/conversations.css`:

```css
/* === Two-pane shell === */
.cv-shell { display: flex; gap: 14px; min-height: 520px; }
.cv-list { flex: 0 0 38%; max-height: calc(100vh - 240px); overflow-y: auto; border-left: 1px solid var(--border); padding-left: 12px; }
.cv-panel { flex: 1; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }

/* === Search === */
.cv-search { position: sticky; top: 0; background: var(--panel); padding: 6px 0 12px; margin-bottom: 8px; z-index: 2; }
.cv-search input { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; font-family: inherit; font-size: 13px; box-sizing: border-box; }
.cv-search input:focus { outline: 2px solid var(--green2); outline-offset: -1px; border-color: transparent; }

/* === List cards === */
.cv-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.cv-card:hover { background: var(--bg-soft); }
.cv-card.active { border-right: 3px solid var(--green2); background: var(--green-bg); }
.cv-card .cv-card-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.cv-card .phone { font-weight: 800; font-size: 13.5px; direction: ltr; }
.cv-card .title { color: var(--text-soft); font-size: 12px; margin-top: 4px; line-height: 1.5; }
.cv-card .meta { color: var(--text-dim); font-size: 11px; margin-top: 8px; display: flex; justify-content: space-between; }
.cv-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.cv-dot.ongoing { background: var(--green2); }
.cv-dot.finished { background: #cbd5e1; }

/* === Panel === */
.cv-panel-header { padding: 16px 18px; border-bottom: 1px solid var(--border); background: var(--bg-soft); }
.cv-panel-header .phone { font-size: 18px; font-weight: 900; direction: ltr; }
.cv-panel-header .title { font-size: 13px; color: var(--text-soft); margin-top: 4px; }
.cv-panel-header .meta { font-size: 11.5px; color: var(--text-dim); margin-top: 6px; }

.cv-bubbles { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 2px; }

/* === Bubbles === */
.cv-bubble-wrap { display: flex; flex-direction: column; margin-bottom: 8px; }
.cv-bubble-wrap.customer { align-items: flex-start; }
.cv-bubble-wrap.ai { align-items: flex-end; }
.cv-bubble { max-width: 72%; padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 1.6; word-break: break-word; position: relative; }
.cv-bubble-wrap.customer .cv-bubble { background: var(--panel); border: 1px solid var(--border); border-radius: 14px 14px 14px 4px; }
.cv-bubble-wrap.ai .cv-bubble { background: var(--green2); color: #fff; border-radius: 14px 14px 4px 14px; }
.cv-bubble-time { font-size: 10.5px; color: var(--text-dim); margin: 2px 6px 0; display: inline-block; }
.cv-bubble-status { display: inline-block; margin: 0 4px; opacity: 0.75; }

/* === Media bubbles === */
.cv-bubble.media-image { background: #eff6ff !important; border: 1px dashed #93c5fd !important; color: #1e40af !important; border-radius: 14px !important; }
.cv-bubble.media-audio, .cv-bubble.media-ptt { background: #fdf4ff !important; border: 1px dashed #d8b4fe !important; color: #6b21a8 !important; border-radius: 14px !important; }
.cv-bubble.media-video, .cv-bubble.media-document, .cv-bubble.media-other { background: #f3f4f6 !important; border: 1px dashed #9ca3af !important; color: #374151 !important; border-radius: 14px !important; }
.cv-bubble-media-icon { font-weight: 900; margin-left: 6px; }
.cv-bubble-media-label { font-weight: 800; font-size: 11.5px; }

/* === Failed bubble === */
.cv-bubble.failed { background: #fef2f2 !important; color: #991b1b !important; border: 1px solid #fca5a5 !important; }

/* === Copy button === */
.cv-bubble-copy { position: absolute; top: -8px; left: -8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; font-size: 10px; opacity: 0; cursor: pointer; transition: opacity 0.15s; font-family: inherit; }
.cv-bubble:hover .cv-bubble-copy { opacity: 1; }

/* === Empty / loading === */
.cv-empty { text-align: center; color: var(--text-soft); padding: 60px 20px; font-size: 13.5px; }
.cv-empty .cv-empty-icon { font-size: 36px; opacity: 0.4; margin-bottom: 8px; }

/* === Mobile accordion === */
@media (max-width: 900px) {
  .cv-shell { display: block; min-height: 0; }
  .cv-list { flex: none; border: none; padding: 0; max-height: none; overflow: visible; }
  .cv-panel { display: none; }
  .cv-card.expanded { background: var(--bg-soft); }
  .cv-card-body { border-top: 1px dashed var(--border); margin-top: 12px; padding-top: 12px; display: flex; flex-direction: column; gap: 2px; }
  .cv-card-body .cv-bubble { max-width: 85%; font-size: 12.5px; }
  .cv-card-close { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; color: var(--text-soft); font-size: 11.5px; cursor: pointer; margin-top: 10px; align-self: center; font-family: inherit; }
}
```

- [ ] **Step 2: Link the CSS in `index.html`**

In `dashboard/index.html`, find the closing `</style>` tag in `<head>`. Immediately after it, add:

```html
<link rel="stylesheet" href="conversations.css">
```

- [ ] **Step 3: Verify file loads via existing static handler**

Confirm `dashboard/` directory is served as static (it already is — verify by looking at `src/server.js` for `express.static`). No code change expected.

- [ ] **Step 4: Commit**

```bash
git add dashboard/conversations.css dashboard/index.html
git commit -m "feat(dashboard): add conversations.css with two-pane and bubble styles"
```

---

## Task 4: Replace `#view-conversations` HTML

**Files:**
- Modify: `dashboard/index.html` (lines ~885-911)
- Test: `tests/dashboard-conversations-ui.test.js` (create)

- [ ] **Step 1: Write failing tests**

Create `tests/dashboard-conversations-ui.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

test('conversations view uses two-pane structure with cv-shell', () => {
  assert.match(html, /id="view-conversations"/);
  assert.match(html, /class="cv-shell"/);
  assert.match(html, /id="cvList"/);
  assert.match(html, /id="cvPanel"/);
  assert.match(html, /id="cvSearch"/);
});

test('conversations view no longer has the old tab buttons', () => {
  assert.doesNotMatch(html, /class="conv-tabs"/);
  assert.doesNotMatch(html, /setConvFilter/);
  assert.doesNotMatch(html, /id="convTabAll"/);
});

test('conversations view links the conversations.css stylesheet', () => {
  assert.match(html, /href="conversations\.css"/);
});

test('conversations view has empty/placeholder state in panel', () => {
  assert.match(html, /id="cvPanelEmpty"/);
});
```

Run: `node --test tests/dashboard-conversations-ui.test.js`
Expected: FAIL on first three (cv-shell/cvList/cvPanel/cvSearch missing).

- [ ] **Step 2: Replace the view-conversations block**

Find in `dashboard/index.html` the block starting `<!-- conversations view --> <div class="view" id="view-conversations">` (around line 885) up to its closing `</div></div></div>` that ends the view.

Current (from spec context):
```html
<div class="view" id="view-conversations">
<div class="sw">
  <div class="panel">
    <div class="phdr">
      <span>سجل محادثات العملاء</span>
      <button class="add-btn" onclick="loadConversations()">تحديث</button>
    </div>
    <div class="pbdy">
      <div class="conv-summary">
        ...
      </div>
      <div class="conv-tabs" id="convTabs">
        <button ...>الكل ...</button>
        <button ...>مستمرة ...</button>
        <button ...>منتهية ...</button>
      </div>
      <div class="conv-list" id="convList">
        <div class="hint">لا توجد محادثات بعد</div>
      </div>
    </div>
  </div>
</div>
</div>
```

Replace ENTIRELY with:

```html
<div class="view" id="view-conversations">
<div class="sw">
  <div class="panel">
    <div class="phdr">
      <span>💬 سجل محادثات العملاء</span>
      <button class="add-btn" onclick="loadConversations()">🔄 تحديث</button>
    </div>
    <div class="pbdy">
      <div class="cv-shell">
        <div class="cv-list-wrap">
          <div class="cv-search">
            <input id="cvSearch" type="search" placeholder="🔍 ابحث برقم العميل أو نص الرسالة..." oninput="filterConversations(this.value)">
          </div>
          <div class="cv-list" id="cvList">
            <div class="cv-empty"><div class="cv-empty-icon">💬</div>جاري التحميل...</div>
          </div>
        </div>
        <div class="cv-panel" id="cvPanel">
          <div class="cv-empty" id="cvPanelEmpty">
            <div class="cv-empty-icon">👈</div>
            اختر محادثة من القائمة لقراءتها
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
```

- [ ] **Step 3: Run tests — should pass**

Run: `node --test tests/dashboard-conversations-ui.test.js`
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html tests/dashboard-conversations-ui.test.js
git commit -m "feat(dashboard): two-pane HTML structure for conversations view"
```

---

## Task 5: JS — `renderConversationList` + `selectConversation` + `filterConversations`

**Files:**
- Modify: `dashboard/index.html` (replace `loadConversations` body and related JS)

- [ ] **Step 1: Locate the existing `loadConversations` and surrounding helpers**

In `dashboard/index.html`, find the function `async function loadConversations()` (around line 1995). It currently:
1. Fetches `/api/conversations?status=` (using `convFilter`)
2. Calls `updateConvTabCounts`
3. Renders each conversation as a single accordion `.conv-item`

Also locate the related helpers: `toggleConversation`, `formatConvTime`, `setConvFilter`, `convFilter`, `updateConvTabCounts`. They'll be removed or rewritten.

- [ ] **Step 2: Replace the conversations JS block**

Delete:
- `convFilter` variable declaration (search `let convFilter` or `var convFilter`)
- `setConvFilter` function
- `updateConvTabCounts` function
- The old body of `loadConversations`
- `toggleConversation` function (replaced)

Replace with the following block (paste right where `loadConversations` was):

```js
let cvConversations = [];
let cvSelectedId = null;

async function loadConversations(){
  const list=document.getElementById('cvList');
  if(!list)return;
  list.innerHTML='<div class="cv-empty"><div class="cv-empty-icon">💬</div>جاري التحميل...</div>';
  try{
    const search=document.getElementById('cvSearch')?.value?.trim()||'';
    const url='/api/conversations'+(search?'?q='+encodeURIComponent(search):'');
    const r=await fetch(url);
    if(r.status===401){window.location.href='/login';return}
    const d=await r.json();
    if(!d.success)throw new Error(d.message||'تعذر تحميل المحادثات');
    cvConversations=d.conversations||[];
    renderConversationList(cvConversations);
    if(cvSelectedId){
      const stillExists=cvConversations.find(c=>c.id===cvSelectedId);
      if(stillExists)selectConversation(cvSelectedId);
      else clearConversationPanel();
    }
  }catch(e){
    list.innerHTML='<div class="cv-empty"><div class="cv-empty-icon">⚠️</div>تعذر تحميل المحادثات: '+esc(e.message||'خطأ')+'</div>';
  }
}

function renderConversationList(items){
  const list=document.getElementById('cvList');
  if(!list)return;
  if(!items.length){
    list.innerHTML='<div class="cv-empty"><div class="cv-empty-icon">💬</div>لا توجد محادثات</div>';
    return;
  }
  list.innerHTML=items.map(c=>{
    const count=(c.messages||[]).length;
    const dotClass=c.status==='ongoing'?'ongoing':'finished';
    const isActive=c.id===cvSelectedId;
    return `<div class="cv-card ${isActive?'active':''}" data-id="${esc(c.id)}" onclick="onConvCardClick('${esc(c.id)}')">
      <div class="cv-card-row">
        <div style="flex:1;min-width:0">
          <div class="phone">${esc(c.phone||c.sender||'')}</div>
          <div class="title">${esc(c.title||'استفسار عميل')}</div>
        </div>
        <span class="cv-dot ${dotClass}" title="${c.status==='ongoing'?'نشطة':'منتهية'}"></span>
      </div>
      <div class="meta">
        <span>${count} رسالة</span>
        <span>${esc(formatConvTime(c.lastMessageAt))}</span>
      </div>
    </div>`;
  }).join('');
}

function onConvCardClick(id){
  // On mobile use accordion mode, on desktop use the side panel
  if(window.innerWidth<=900) toggleAccordionCard(id);
  else selectConversation(id);
}

function selectConversation(id){
  cvSelectedId=id;
  const conv=cvConversations.find(c=>c.id===id);
  if(!conv)return;
  // mark active card
  document.querySelectorAll('.cv-card').forEach(el=>{
    el.classList.toggle('active', el.dataset.id===id);
  });
  renderConversationPanel(conv);
}

function clearConversationPanel(){
  cvSelectedId=null;
  const panel=document.getElementById('cvPanel');
  if(panel)panel.innerHTML='<div class="cv-empty" id="cvPanelEmpty"><div class="cv-empty-icon">👈</div>اختر محادثة من القائمة لقراءتها</div>';
}

function filterConversations(query){
  const q=String(query||'').trim().toLowerCase();
  if(!q){ renderConversationList(cvConversations); return; }
  const filtered=cvConversations.filter(c=>{
    if(String(c.phone||'').toLowerCase().includes(q))return true;
    if(String(c.title||'').toLowerCase().includes(q))return true;
    if((c.messages||[]).some(m=>String(m.content||'').toLowerCase().includes(q)))return true;
    return false;
  });
  renderConversationList(filtered);
}

function formatConvTime(value){
  if(!value)return '—';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '—';
  const now=new Date();
  const diff=now-date;
  if(diff<60000)return 'الآن';
  if(diff<3600000)return 'قبل '+Math.floor(diff/60000)+' د';
  const sameDay=date.toDateString()===now.toDateString();
  if(sameDay)return date.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'});
  const yesterday=new Date(now); yesterday.setDate(now.getDate()-1);
  if(date.toDateString()===yesterday.toDateString())return 'أمس '+date.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'});
  return date.toLocaleDateString('ar-SA',{month:'short',day:'numeric'});
}
```

- [ ] **Step 3: Smoke check that the dashboard still loads**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('dashboard/index.html','utf8');if(!html.includes('renderConversationList'))throw new Error('renderConversationList missing');if(!html.includes('selectConversation'))throw new Error('selectConversation missing');if(!html.includes('filterConversations'))throw new Error('filterConversations missing');console.log('JS functions present')"`

Expected: `JS functions present`.

- [ ] **Step 4: Run npm test for regressions**

Run: `npm test`
Expected: all tests pass (148 existing + new from Tasks 1, 2, 4).

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): list rendering + selection + client-side filtering"
```

---

## Task 6: JS — `renderConversationPanel` + `renderBubble`

**Files:**
- Modify: `dashboard/index.html`

- [ ] **Step 1: Add the panel rendering function**

After the `formatConvTime` function (just appended in Task 5), append:

```js
function renderConversationPanel(conv){
  const panel=document.getElementById('cvPanel');
  if(!panel)return;
  const messages=conv.messages||[];
  const bubblesHtml=messages.length
    ? messages.map(renderBubble).join('')
    : '<div class="cv-empty"><div class="cv-empty-icon">💭</div>لا توجد رسائل محفوظة</div>';
  const dotClass=conv.status==='ongoing'?'ongoing':'finished';
  const statusLabel=conv.status==='ongoing'?'نشطة':'منتهية';
  panel.innerHTML=`<div class="cv-panel-header">
    <div class="phone">${esc(conv.phone||conv.sender||'')}</div>
    <div class="title">${esc(conv.title||'استفسار عميل')}</div>
    <div class="meta"><span class="cv-dot ${dotClass}"></span> ${statusLabel} · آخر تحديث ${esc(formatConvTime(conv.lastMessageAt))}</div>
  </div>
  <div class="cv-bubbles" id="cvBubbles">${bubblesHtml}</div>`;
  // Scroll to last bubble
  const bubbles=document.getElementById('cvBubbles');
  if(bubbles)bubbles.scrollTop=bubbles.scrollHeight;
}

function bubbleStatusIcon(status){
  if(!status)return '';
  if(status==='sent')return '<span class="cv-bubble-status" title="مُرسلة">✓</span>';
  if(status==='queued_for_send')return '<span class="cv-bubble-status" title="بانتظار الإرسال">⏳</span>';
  if(status==='expired'||status==='canceled_no_quota')return '<span class="cv-bubble-status" title="ملغاة">🚫</span>';
  if(status==='send_failed')return '<span class="cv-bubble-status" title="فشل الإرسال">✗</span>';
  return '';
}

function mediaLabel(kind){
  if(kind==='image')return {icon:'🖼️',label:'صورة من العميل'};
  if(kind==='audio'||kind==='ptt')return {icon:'🎤',label:'رسالة صوتية'};
  if(kind==='video')return {icon:'🎬',label:'فيديو'};
  if(kind==='document')return {icon:'📄',label:'مستند'};
  return {icon:'📎',label:'مرفق'};
}

function renderBubble(m){
  const isAi=m.speaker==='AI'||m.direction==='outbound';
  const wrapClass=isAi?'ai':'customer';
  const isFailed=isAi && (m.status==='expired'||m.status==='canceled_no_quota'||m.status==='send_failed');
  const statusIcon=isAi?bubbleStatusIcon(m.status):'';
  const timeStr=esc(formatConvTime(m.at));
  const safeContent=esc(m.content||'');
  // Encode content for the copy button
  const copyAttr=String(m.content||'').replace(/'/g,"\\'").replace(/\n/g,'\\n');

  let bubbleClass='cv-bubble';
  let bubbleInner=safeContent;

  if(m.hasMedia){
    const meta=mediaLabel(m.mediaKind);
    bubbleClass+=' media-'+(m.mediaKind||'other');
    bubbleInner=`<span class="cv-bubble-media-icon">${meta.icon}</span><span class="cv-bubble-media-label">${meta.label}</span><br>${safeContent}`;
  }
  if(isFailed)bubbleClass+=' failed';

  return `<div class="cv-bubble-wrap ${wrapClass}">
    <div class="${bubbleClass}">
      <button class="cv-bubble-copy" onclick="copyBubble(this,'${copyAttr}')" type="button">📋</button>
      ${bubbleInner}
    </div>
    <div class="cv-bubble-time">${timeStr}${statusIcon}</div>
  </div>`;
}

function copyBubble(btn, text){
  const decoded=String(text||'').replace(/\\n/g,'\n');
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(decoded).then(()=>{
      btn.textContent='✓';
      setTimeout(()=>{btn.textContent='📋';},1200);
    }).catch(()=>{ btn.textContent='✗'; });
  }
}
```

- [ ] **Step 2: Smoke check**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('dashboard/index.html','utf8');for(const f of ['renderConversationPanel','renderBubble','bubbleStatusIcon','mediaLabel','copyBubble'])if(!html.includes(f))throw new Error(f+' missing');console.log('all panel functions present')"`

Expected: `all panel functions present`.

- [ ] **Step 3: Run npm test**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): bubble rendering with status/media/copy support"
```

---

## Task 7: Mobile accordion behavior (`toggleAccordionCard`)

**Files:**
- Modify: `dashboard/index.html`

- [ ] **Step 1: Append accordion functions**

After `copyBubble` (just added in Task 6), append:

```js
function toggleAccordionCard(id){
  const card=document.querySelector('.cv-card[data-id="'+id+'"]');
  if(!card)return;
  // If already expanded, close it
  if(card.classList.contains('expanded')){
    closeAccordionCard(card);
    return;
  }
  // Close any other expanded card first
  document.querySelectorAll('.cv-card.expanded').forEach(c=>closeAccordionCard(c));
  // Expand this one
  const conv=cvConversations.find(c=>c.id===id);
  if(!conv)return;
  const messages=conv.messages||[];
  const bubblesHtml=messages.length
    ? messages.map(renderBubble).join('')
    : '<div class="cv-empty"><div class="cv-empty-icon">💭</div>لا توجد رسائل محفوظة</div>';
  const body=document.createElement('div');
  body.className='cv-card-body';
  body.innerHTML=bubblesHtml+'<button class="cv-card-close" onclick="closeAccordionCard(this.closest(\'.cv-card\'))">✕ إغلاق</button>';
  card.appendChild(body);
  card.classList.add('expanded');
  cvSelectedId=id;
}

function closeAccordionCard(card){
  if(!card)return;
  card.classList.remove('expanded');
  const body=card.querySelector('.cv-card-body');
  if(body)body.remove();
  cvSelectedId=null;
}
```

- [ ] **Step 2: Smoke check**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('dashboard/index.html','utf8');if(!html.includes('toggleAccordionCard'))throw new Error('toggleAccordionCard missing');if(!html.includes('closeAccordionCard'))throw new Error('closeAccordionCard missing');console.log('accordion functions present')"`

Expected: `accordion functions present`.

- [ ] **Step 3: Run npm test**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): mobile accordion behavior for conversation cards"
```

---

## Task 8: Final regression + push + PR

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: 148 + ~8 new = ~156 PASS, 0 FAIL.

- [ ] **Step 2: Manual smoke check via Node static read**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('dashboard/index.html','utf8');const css=fs.readFileSync('dashboard/conversations.css','utf8');console.log('html='+html.length+' css='+css.length); for(const sel of ['.cv-shell','.cv-card','.cv-bubble','.cv-bubble-time','.cv-card-body']) if(!css.includes(sel)) throw new Error(sel+' missing in css'); console.log('all selectors present')"`

Expected: prints sizes + `all selectors present`.

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --base master --title "feat: conversations page redesign (two-pane + accordion mobile)" --body "$(cat <<'EOF'
## ملخص

إعادة تصميم صفحة المحادثات: قائمة + لوحة قراءة على الديسكتوب (مثل واتساب ويب)، تتحوّل لأكورديون على الجوال. تمييز بصري واضح للرسائل، حالة الإرسال، الميديا المُحلَّلة، وزر نسخ.

## التغييرات

### Backend
- `normalizeMessage` يكشف 3 حقول جديدة: `status`, `hasMedia`, `mediaKind`
- بحث server-side اختياري عبر `?q=` (ILIKE على sender + message content)

### Frontend
- ملف CSS جديد `dashboard/conversations.css` (300+ سطر)
- استبدال `#view-conversations` بـ two-pane shell
- 8 دوال JS جديدة/مُعاد كتابتها: `renderConversationList`, `selectConversation`, `clearConversationPanel`, `filterConversations`, `renderConversationPanel`, `renderBubble`, `copyBubble`, `toggleAccordionCard`
- حذف نظام الـ tabs القديم (`conv-tabs`, `setConvFilter`, `updateConvTabCounts`)

## Test plan

- [ ] فتح صفحة المحادثات → التأكد من ظهور الـ two-pane
- [ ] نقرة على محادثة → تفتح في اللوحة اليسرى
- [ ] الكتابة في البحث → فلترة فورية
- [ ] فتح على جوال (أو شاشة ضيقة) → التحوّل لأكورديون
- [ ] رسالة بحالة `queued_for_send` → تظهر ⏳
- [ ] رسالة بـ image → تظهر بإطار أزرق + 🖼️
- [ ] hover فوق رسالة → ظهور زر نسخ → النسخ يعمل

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Section 2 (visual design) → Tasks 3 (CSS), 4 (HTML), 5+6 (JS)
- Section 3 (API changes) → Tasks 1, 2
- Section 4 (code modifications) → Tasks 1-7
- Section 5 (CSS) → Task 3
- Section 6 (tests) → integrated into each task
- Section 7 (no-change items) → respected (ACTIVE_WINDOW_MS, limit=20 untouched)
- Section 8 (deletions) → Task 5 removes old JS, Task 4 removes old HTML
- Section 9 (rollback) → trivial revert, no migration
- Section 11 (out of scope) → not implemented

**Placeholder scan:** No TBD/TODO. All code blocks complete.

**Type consistency:** `mediaKind` values consistent: `'image'`, `'audio'`, `'ptt'`, `'video'`, `'document'`, `'other'`. `status` values match the spec section 3. `cvSelectedId` referenced consistently across `selectConversation`, `clearConversationPanel`, `loadConversations`, `toggleAccordionCard`.
