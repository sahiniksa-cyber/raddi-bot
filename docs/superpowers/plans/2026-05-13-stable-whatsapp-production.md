# Stable WhatsApp Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hosted WhatsApp customer-service platform stable by defaulting production to Baileys, preserving QR-in-browser linking, and verifying AI replies use the configured conversation memory.

**Architecture:** Keep the existing Express dashboard and BullMQ pipeline. Add small testable helpers around WhatsApp engine selection and AI history loading, then wire those helpers into `RuntimeBot` and `ai-worker`. Use PostgreSQL for auth/session/config state and Redis for queues.

**Tech Stack:** Node.js CommonJS, Express, Baileys, PostgreSQL `pg`, Redis/BullMQ, built-in `node:test`.

---

## File Structure

- Create `src/services/bot/engine-config.js`: resolves and validates the WhatsApp engine from `WA_ENGINE`, defaulting to `baileys`.
- Modify `src/services/bot/runtime-bot.js`: use `resolveWhatsappEngine()` instead of hard-coded `whatsapp-web` fallback.
- Create `src/workers/ai-history.js`: normalizes `memoryMessages` and loads conversation history in correct order.
- Modify `src/workers/ai-worker.js`: use `ai-history`, export helper seams for tests, and mark inbound messages as failed when AI generation fails.
- Create `tests/engine-config.test.js`: verifies production-safe engine defaults.
- Create `tests/ai-history.test.js`: verifies default/custom memory and latest-message inclusion.
- Create `tests/ai-worker-failure.test.js`: verifies AI failure marks the inbound message as `ai_failed`.
- Modify `package.json`: add `test` script using `node --test`.
- Modify `Dockerfile`: set `WA_ENGINE=baileys`.
- Modify `.env.example`: document `WA_ENGINE=baileys` and AI memory expectations.
- Create `docs/railway-production.md`: concise deployment checklist for Railway variables, QR flow, and health checks.

## Task 1: Testable WhatsApp Engine Selection

**Files:**
- Create: `tests/engine-config.test.js`
- Create: `src/services/bot/engine-config.js`
- Modify: `src/services/bot/runtime-bot.js`
- Modify: `package.json`

- [ ] **Step 1: Add the failing engine tests**

Create `tests/engine-config.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWhatsappEngine } = require('../src/services/bot/engine-config');

test('defaults to baileys when WA_ENGINE is empty', () => {
  assert.equal(resolveWhatsappEngine({}), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: '' }), 'baileys');
});

test('accepts explicit whatsapp-web as fallback engine', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp-web' }), 'whatsapp-web');
});

test('normalizes aliases to stable engine names', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'BAILEYS' }), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp_web' }), 'whatsapp-web');
});
```

- [ ] **Step 2: Add the test script**

Change `package.json` scripts to include:

```json
"test": "node --test"
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- tests/engine-config.test.js`

Expected: FAIL with `Cannot find module '../src/services/bot/engine-config'`.

- [ ] **Step 4: Implement engine helper**

Create `src/services/bot/engine-config.js`:

```js
'use strict';

const SUPPORTED_ENGINES = new Set(['baileys', 'whatsapp-web']);

function resolveWhatsappEngine(env = process.env) {
  const raw = String(env.WA_ENGINE || '').trim().toLowerCase().replace(/_/g, '-');
  const engine = raw || 'baileys';
  return SUPPORTED_ENGINES.has(engine) ? engine : 'baileys';
}

module.exports = {
  resolveWhatsappEngine,
  SUPPORTED_ENGINES,
};
```

- [ ] **Step 5: Wire helper into RuntimeBot**

In `src/services/bot/runtime-bot.js`, add:

```js
const { resolveWhatsappEngine } = require('./engine-config');
```

Replace:

```js
const engine = (process.env.WA_ENGINE || 'whatsapp-web').trim().toLowerCase();
```

With:

```js
const engine = resolveWhatsappEngine(process.env);
```

- [ ] **Step 6: Verify GREEN**

Run: `npm test -- tests/engine-config.test.js`

Expected: PASS.

## Task 2: AI Memory Loading Uses User Choice

**Files:**
- Create: `tests/ai-history.test.js`
- Create: `src/workers/ai-history.js`
- Modify: `src/workers/ai-worker.js`

- [ ] **Step 1: Add failing AI history tests**

Create `tests/ai-history.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHistoryForReply, normalizeMemoryLimit } = require('../src/workers/ai-history');

test('normalizeMemoryLimit defaults to 50 and never below 2', () => {
  assert.equal(normalizeMemoryLimit({}), 50);
  assert.equal(normalizeMemoryLimit({ memoryMessages: '' }), 50);
  assert.equal(normalizeMemoryLimit({ memoryMessages: 1 }), 2);
  assert.equal(normalizeMemoryLimit({ memoryMessages: '7' }), 7);
});

test('buildHistoryForReply loads latest messages in chronological order', async () => {
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [
          { role: 'assistant', content: 'second answer' },
          { role: 'user', content: 'second question' },
          { role: 'assistant', content: 'first answer' },
        ],
      };
    },
  };

  const history = await buildHistoryForReply({
    db,
    conversationId: 'conv-1',
    config: { memoryMessages: 3 },
    inboundText: 'second question',
  });

  assert.deepEqual(queries[0].params, ['conv-1', 3]);
  assert.deepEqual(history, [
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ]);
});

test('buildHistoryForReply appends inbound text when not already last user message', async () => {
  const db = {
    query: async () => ({
      rows: [
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'old question' },
      ],
    }),
  };

  const history = await buildHistoryForReply({
    db,
    conversationId: 'conv-1',
    config: { memoryMessages: 2 },
    inboundText: 'new question',
  });

  assert.deepEqual(history, [
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/ai-history.test.js`

Expected: FAIL with `Cannot find module '../src/workers/ai-history'`.

- [ ] **Step 3: Implement AI history helper**

Create `src/workers/ai-history.js`:

```js
'use strict';

function normalizeMemoryLimit(config = {}) {
  return Math.max(2, parseInt(config.memoryMessages, 10) || 50);
}

async function loadHistory(db, conversationId, limit) {
  const result = await db.query(
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  return result.rows
    .reverse()
    .map(row => ({ role: row.role, content: row.content }));
}

async function buildHistoryForReply({ db, conversationId, config, inboundText }) {
  const memSize = normalizeMemoryLimit(config);
  const history = await loadHistory(db, conversationId, memSize);
  const text = String(inboundText || '').trim();
  const last = history[history.length - 1];

  if (text && (!last || last.role !== 'user' || last.content !== text)) {
    history.push({ role: 'user', content: text });
  }
  if (history.length > memSize) history.splice(0, history.length - memSize);
  return history;
}

module.exports = {
  buildHistoryForReply,
  loadHistory,
  normalizeMemoryLimit,
};
```

- [ ] **Step 4: Wire helper into AI worker**

In `src/workers/ai-worker.js`, add:

```js
const { buildHistoryForReply } = require('./ai-history');
```

Remove the local `loadHistory` function. Replace the memory block in `processAiReply`:

```js
const memSize = Math.max(2, parseInt(config.memoryMessages, 10) || 50);
const history = await loadHistory(conversation.id, memSize);
const last = history[history.length - 1];
if (!last || last.role !== 'user' || last.content !== text) {
  history.push({ role: 'user', content: text });
}
if (history.length > memSize) history.splice(0, history.length - memSize);
```

With:

```js
const history = await buildHistoryForReply({
  db,
  conversationId: conversation.id,
  config,
  inboundText: text,
});
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/ai-history.test.js`

Expected: PASS.

## Task 3: AI Failure Marks the Message

**Files:**
- Create: `tests/ai-worker-failure.test.js`
- Modify: `src/workers/ai-worker.js`

- [ ] **Step 1: Add failing failure-status test**

Create `tests/ai-worker-failure.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { markInboundMessageFailed } = require('../src/workers/ai-worker');

test('markInboundMessageFailed stores ai failure details on inbound message', async () => {
  const calls = [];
  const fakeDb = {
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await markInboundMessageFailed({
    database: fakeDb,
    messageId: 'msg-1',
    error: new Error('missing api key'),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE messages/);
  assert.deepEqual(calls[0].params, [
    'msg-1',
    'ai_failed',
    JSON.stringify({
      aiFailedAt: calls[0].params[2] ? JSON.parse(calls[0].params[2]).aiFailedAt : undefined,
      error: 'missing api key',
    }),
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/ai-worker-failure.test.js`

Expected: FAIL because `markInboundMessageFailed` is not exported.

- [ ] **Step 3: Implement failure marker**

In `src/workers/ai-worker.js`, add:

```js
async function markInboundMessageFailed({ database = db, messageId, error }) {
  if (!messageId || !database.isConfigured()) return;
  await database.query(
    `UPDATE messages
     SET status = $2,
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
     WHERE id = $1`,
    [
      messageId,
      'ai_failed',
      JSON.stringify({
        aiFailedAt: new Date().toISOString(),
        error: error?.message || String(error || 'AI failed'),
      }),
    ],
  );
}
```

Wrap `processAiReply` after payload validation so errors update the inbound message:

```js
async function processAiReply(job) {
  const payload = job.data || {};
  try {
    // existing body using payload
  } catch (err) {
    await markInboundMessageFailed({ messageId: payload.messageId, error: err }).catch(() => {});
    throw err;
  }
}
```

Export the helper:

```js
markInboundMessageFailed,
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/ai-worker-failure.test.js`

Expected: PASS.

## Task 4: Railway Production Defaults and Docs

**Files:**
- Modify: `Dockerfile`
- Modify: `.env.example`
- Create: `docs/railway-production.md`

- [ ] **Step 1: Change Dockerfile default engine**

Replace:

```dockerfile
ENV WA_ENGINE=whatsapp-web
```

With:

```dockerfile
ENV WA_ENGINE=baileys
```

- [ ] **Step 2: Update `.env.example`**

Ensure the WhatsApp section contains:

```dotenv
WA_ENGINE=baileys
# Baileys shows QR in the hosted dashboard and stores auth in PostgreSQL.
# Use whatsapp-web only as an emergency fallback when Chromium/session storage is configured.
```

Ensure the AI worker section mentions:

```dotenv
# The dashboard controls memoryMessages. Default is 50 recent messages per conversation.
AI_WORKER_CONCURRENCY=2
```

- [ ] **Step 3: Add Railway guide**

Create `docs/railway-production.md`:

```md
# Railway Production Setup

## Required variables

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`
- `WA_ENGINE=baileys`

## Start command

Use the repository default Railway command:

```bash
npm run start:all
```

## First WhatsApp link

1. Open the hosted dashboard URL.
2. Log in.
3. Press the bot start button.
4. Wait for the QR screen.
5. Scan it from WhatsApp linked devices.
6. After it connects, the Baileys auth state is saved in PostgreSQL.

## Health checks

- `/health` confirms the web process is alive.
- `/ready` confirms PostgreSQL and Redis are reachable.

## AI replies

Incoming messages are stored in PostgreSQL, then queued through Redis/BullMQ. The AI worker loads `memoryMessages` from the dashboard config. The default is 50 recent messages per conversation.
```

- [ ] **Step 4: Verify docs/config**

Run: `Select-String -Path Dockerfile,.env.example,docs\\railway-production.md -Pattern 'WA_ENGINE=baileys|memoryMessages|DATABASE_URL|REDIS_URL'`

Expected: matching lines in all relevant files.

## Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run JavaScript syntax checks**

Run:

```powershell
$files = rg --files -g '*.js'; foreach ($f in $files) { node --check $f; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run database migration**

Run: `npm run db:migrate`

Expected: `Database migration completed`.

- [ ] **Step 4: Verify DB and Redis connectivity**

Run:

```powershell
node -e "require('dotenv').config({quiet:true}); const db=require('./src/db/client'); db.ping().then(()=>console.log('DB_OK')).catch(e=>{console.error('DB_FAIL', e.message); process.exitCode=1}).finally(()=>db.close())"
node -e "require('dotenv').config({quiet:true}); const {ping}=require('./src/queues/redis'); ping().then(r=>console.log('REDIS_OK', r)).catch(e=>{console.error('REDIS_FAIL', e.message); process.exitCode=1})"
```

Expected: `DB_OK` and `REDIS_OK PONG`.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add Dockerfile .env.example package.json package-lock.json src tests docs
git commit -m "feat: stabilize whatsapp production runtime"
```

Expected: commit succeeds.

## Self-Review

- Spec coverage: Tasks cover Baileys default, QR-in-browser preservation through existing API, PostgreSQL session auth, AI memory loading, AI failure visibility, Railway docs, and verification.
- Placeholder scan: no TBD/TODO/later placeholders.
- Type consistency: helper names are `resolveWhatsappEngine`, `normalizeMemoryLimit`, `buildHistoryForReply`, and `markInboundMessageFailed` across tests, implementation, and exports.
