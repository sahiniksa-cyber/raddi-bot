# Save Manual sendMessage to DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the admin sends a message via `POST /api/send-message` (the bot controller's `sendMessage` action), store it to the `messages` table so it appears in conversation history and is visible in the dashboard.

**Architecture:** `createBotController` receives a `deps` object; we add `database` to that object (defaulting to the real `db` singleton). After a successful WhatsApp send, the handler inserts a row into `messages` (direction=outbound, role=assistant, status=sent) and upserts `conversations`.

**Tech Stack:** Node.js, `node:test`, `node:assert/strict`, PostgreSQL via `pg`. All tests use in-memory stub databases (no real DB needed).

---

### Task 1: Wire database dep into bot controller and store message after send

**Files:**
- Modify: `src/controllers/bot.controller.js`
- Modify: `src/server.js` (pass `database: db` to `createBotController`)
- Create: `tests/bot-controller-send-message-store.test.js`

**Context:**

`createBotController` currently only receives `{ getUserBot }`. The `sendMessage` handler (lines 100-121) calls `bot.client.sendMessage()` but never writes to the DB.

We need to:
1. Accept `database` in deps (default: `require('../db/client')`)
2. After `sendMessage` succeeds, upsert the conversation and insert the outbound message

The upsert+insert pattern (used in `ai-worker.js`) is:
```sql
-- Upsert conversation
INSERT INTO conversations (user_id, sender, last_message_at)
VALUES ($1, $2, NOW())
ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
RETURNING id

-- Insert outbound message
INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'sent', $6::jsonb)
```

The `provider_message_id` for manual sends should be `manual:${userId}:${randomUUID()}`.

- [ ] **Step 1: Write the failing test**

Create `tests/bot-controller-send-message-store.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBotController } = require('../src/controllers/bot.controller');

function makeDb(overrides = {}) {
  const queries = [];
  return {
    queries,
    isConfigured: () => true,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO conversations') || sql.includes('ON CONFLICT')) {
        return { rows: [{ id: 'conv-id-1' }] };
      }
      if (sql.includes('INSERT INTO messages')) {
        return { rows: [{ id: 'msg-id-1' }] };
      }
      return { rows: [] };
    },
    ...overrides,
  };
}

function makeBot({ connected = true } = {}) {
  return {
    userId: 'user-1',
    botRunning: connected,
    appState: { status: connected ? 'connected' : 'stopped' },
    client: connected ? {
      sendMessage: async () => {},
    } : null,
    log: () => {},
  };
}

function makeReq(body = {}) {
  return {
    session: { userId: 'user-1' },
    body: { phone: '966501234567', message: 'مرحبا', ...body },
  };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

test('sendMessage stores outbound message to DB after successful send', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, true);

  const convQuery = database.queries.find(q => q.sql.includes('INSERT INTO conversations'));
  assert.ok(convQuery, 'should upsert conversation');
  assert.equal(convQuery.params[0], 'user-1');
  assert.ok(convQuery.params[1].includes('966501234567'), 'sender should include phone number');

  const msgQuery = database.queries.find(q => q.sql.includes('INSERT INTO messages'));
  assert.ok(msgQuery, 'should insert outbound message');
  assert.equal(msgQuery.params[1], 'user-1'); // user_id
  assert.ok(msgQuery.params[3] === 'مرحبا', 'content should match sent message');
});

test('sendMessage does not attempt DB write when bot is not connected', async () => {
  const database = makeDb();
  const bot = makeBot({ connected: false });
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, false);
  assert.equal(database.queries.length, 0, 'no DB calls when bot not connected');
});

test('sendMessage does not crash when database is not configured', async () => {
  const database = makeDb({ isConfigured: () => false });
  const bot = makeBot();
  const ctrl = createBotController({
    getUserBot: () => bot,
    database,
  });

  const req = makeReq();
  const res = makeRes();
  await ctrl.sendMessage(req, res);

  assert.equal(res._body.success, true, 'should still succeed even if DB not configured');
});

test('sendMessage rejects missing phone or message', async () => {
  const database = makeDb();
  const bot = makeBot();
  const ctrl = createBotController({ getUserBot: () => bot, database });

  const res = makeRes();
  await ctrl.sendMessage(makeReq({ phone: '' }), res);
  assert.equal(res._status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/bot-controller-send-message-store.test.js
```
Expected: `sendMessage stores outbound message` FAILS (no DB write happens yet).

- [ ] **Step 3: Implement in bot.controller.js**

Open `src/controllers/bot.controller.js`. Replace the `createBotController` function signature and `sendMessage` handler:

```js
'use strict';

const crypto = require('crypto');
const { TIMERS } = require('../../lib/constants');

// ... keep describeStartState unchanged ...

function createBotController({ getUserBot, database = null }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

  const db = database || (() => {
    try { return require('../db/client'); } catch (_) { return null; }
  })();

  return {
    // ... keep status, qr, qrImage, start, stop, restart, clearSession unchanged ...

    async sendMessage(req, res) {
      const bot = getUserBot(req.session.userId);
      const { phone, message } = req.body;
      if (!phone || !message?.trim()) {
        return res.status(400).json({ success: false, message: 'phone and message are required' });
      }
      if (!bot.botRunning || !bot.client || bot.appState.status !== 'connected') {
        return res.json({ success: false, message: 'bot is not connected' });
      }

      const cleanPhone = phone.replace(/\+/g, '').replace(/[\s\-()]/g, '');
      const sender = `${cleanPhone}@s.whatsapp.net`;
      const text = message.trim();

      try {
        await Promise.race([
          bot.client.sendMessage(sender, text),
          new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
        ]);
        bot.log(`direct message sent to ${cleanPhone}`);

        // Persist to DB so the message appears in conversation history
        if (db && typeof db.isConfigured === 'function' && db.isConfigured()) {
          try {
            const userId = bot.userId || req.session.userId;
            const convResult = await db.query(
              `INSERT INTO conversations (user_id, sender, last_message_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (user_id, sender) DO UPDATE SET last_message_at = NOW()
               RETURNING id`,
              [userId, sender],
            );
            const conversationId = convResult.rows[0]?.id;
            if (conversationId) {
              const providerMessageId = `manual:${userId}:${crypto.randomUUID()}`;
              await db.query(
                `INSERT INTO messages
                   (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
                 VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'sent', $6::jsonb)`,
                [conversationId, userId, sender, text, providerMessageId,
                  JSON.stringify({ source: 'manual_send' })],
              );
            }
          } catch (dbErr) {
            // Log but don't fail — message was already sent
            bot.log?.(`warning: failed to persist manual send to DB: ${dbErr.message}`);
          }
        }

        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createBotController, describeStartState };
```

**Important:** Keep `describeStartState` and all other handlers (`status`, `qr`, `qrImage`, `start`, `stop`, `restart`, `clearSession`) exactly as they are. Only add `crypto = require('crypto')` import at the top, add `database = null` to deps, add the DB persistence block in `sendMessage`.

- [ ] **Step 4: Update server.js to pass database dep**

In `src/server.js`, find this line (~line 195):
```js
const wrapBotController = require('./controllers/bot.controller').createBotController({ getUserBot: syncBotLookup });
```
Replace with:
```js
const wrapBotController = require('./controllers/bot.controller').createBotController({ getUserBot: syncBotLookup, database: db });
```

- [ ] **Step 5: Run tests to verify they pass**

```
node --test tests/bot-controller-send-message-store.test.js
```
Expected: 4/4 PASS.

- [ ] **Step 6: Run full test suite**

```
node --test tests/
```
Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/bot.controller.js src/server.js tests/bot-controller-send-message-store.test.js
git commit -m "feat(bot): persist manual sendMessage to conversations+messages DB tables"
```
