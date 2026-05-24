# Phase A — lid Phone Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the customer's real phone number from `message.key.senderPn` in Baileys, store it in a new `conversations.phone_number` column, and use it in the dashboard + escalation notification — replacing the unreadable `@lid` identifier wherever it surfaces to the operator.

**Architecture:** A single helper at the Baileys boundary extracts the phone number into the canonical message payload. The ingest layer persists it via UPSERT with `COALESCE` (immutable per conversation). Downstream readers (`cleanCustomerPhone` for the dashboard, `cleanCustomerJid` for escalations) prefer the new column with a backward-compatible fallback to the existing `sender`. No backfill — historical conversations remain on `@lid` until a new inbound message refreshes them.

**Tech Stack:** Node.js, Baileys 7+, PostgreSQL, BullMQ, Express, `node:test`.

**Spec:** [docs/superpowers/specs/2026-05-25-lid-phone-extraction-design.md](../specs/2026-05-25-lid-phone-extraction-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/db/migrations/init.js` | Modify | Add `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT` |
| `src/services/whatsapp/baileys-connection-manager.js` | Modify | Add `extractPhoneNumber(key)` helper + include `phoneNumber` in `toWhatsappWebMessage` output |
| `src/services/whatsapp/message-ingest.service.js` | Modify | Read `phoneNumber` from msg, persist via UPSERT with COALESCE, forward in `enqueueAiReply` payload |
| `src/workers/ai-worker.js` | Modify | Add `phone_number` to conversation SELECT, pass `customerPhoneNumber` to `prepareEscalation` |
| `src/workers/escalation-routing.js` | Modify | `cleanCustomerJid` and `buildEscalationNotification` accept and prefer `phoneNumber` |
| `src/controllers/conversations.controller.js` | Modify | `cleanCustomerPhone` accepts a row, list SELECT includes `c.phone_number`, payload exposes `phoneNumber` |
| `tests/baileys-extract-phone.test.js` | Create | Unit tests for `extractPhoneNumber` helper |
| `tests/message-ingest.test.js` | Create | Tests for phoneNumber flowing through ingest into UPSERT + enqueueAiReply |
| `tests/conversations-controller.test.js` | Modify | Extend with row-shape variants of `cleanCustomerPhone` |
| `tests/escalation-routing.test.js` | Modify | Extend with phoneNumber-overriding-lid cases |

**Total:** 6 production files + 4 test files (2 new, 2 extended).

---

## Task 1: Migration — add `phone_number` column

**Files:**
- Modify: `src/db/migrations/init.js`

- [ ] **Step 1: Locate the conversations CREATE TABLE block**

Find in `src/db/migrations/init.js` the statement:

```js
  `CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, sender)
  )`,
```

- [ ] **Step 2: Add ALTER statement right after the conversations CREATE TABLE**

Insert this line immediately after the closing `)`,  of the `CREATE TABLE conversations` block:

```js
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT`,
```

The result should look like:

```js
  `CREATE TABLE IF NOT EXISTS conversations (
    ...
    UNIQUE(user_id, sender)
  )`,

  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT`,
```

- [ ] **Step 3: Run the full test suite to ensure nothing broke**

Run: `npm test`

Expected: All currently-passing tests still pass (the migration code path runs only against a real DB; unit tests use fake DBs and won't execute this statement).

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/init.js
git commit -m "feat(db): add phone_number column to conversations"
```

---

## Task 2: Baileys — `extractPhoneNumber` helper + tests

**Files:**
- Modify: `src/services/whatsapp/baileys-connection-manager.js`
- Create: `tests/baileys-extract-phone.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/baileys-extract-phone.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPhoneNumber } = require('../src/services/whatsapp/baileys-connection-manager');

test('extractPhoneNumber returns digits from senderPn for lid remoteJid', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
    senderPn: '966512345678@s.whatsapp.net',
  });
  assert.equal(phone, '966512345678');
});

test('extractPhoneNumber falls back to participantPn when senderPn is missing', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
    participantPn: '966587654321@s.whatsapp.net',
  });
  assert.equal(phone, '966587654321');
});

test('extractPhoneNumber returns digits from a regular remoteJid when no PN fields exist', () => {
  const phone = extractPhoneNumber({
    remoteJid: '966512345678@s.whatsapp.net',
  });
  assert.equal(phone, '966512345678');
});

test('extractPhoneNumber returns null when only lid identifiers are available', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
  });
  assert.equal(phone, null);
});

test('extractPhoneNumber ignores group and broadcast jids', () => {
  assert.equal(extractPhoneNumber({ remoteJid: '120363041234567890@g.us' }), null);
  assert.equal(extractPhoneNumber({ remoteJid: 'status@broadcast' }), null);
});

test('extractPhoneNumber handles null/undefined key gracefully', () => {
  assert.equal(extractPhoneNumber(null), null);
  assert.equal(extractPhoneNumber(undefined), null);
  assert.equal(extractPhoneNumber({}), null);
});

test('extractPhoneNumber strips non-digit characters', () => {
  assert.equal(extractPhoneNumber({ senderPn: '+966-512-345678@s.whatsapp.net' }), '966512345678');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baileys-extract-phone.test.js`

Expected: FAIL — `extractPhoneNumber` is not exported.

- [ ] **Step 3: Add the helper to `baileys-connection-manager.js`**

In `src/services/whatsapp/baileys-connection-manager.js`, after the existing `normalizeOutboundJid` function (around line 76) and BEFORE `toWhatsappWebMessage`, insert:

```js
function extractPhoneNumber(key) {
  if (!key || typeof key !== 'object') return null;
  const candidates = [key.senderPn, key.participantPn, key.remoteJid];
  for (const value of candidates) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    if (raw.endsWith('@lid')) continue;
    if (raw.endsWith('@g.us')) continue;
    if (raw === 'status@broadcast' || raw.endsWith('@broadcast')) continue;
    const digits = raw.replace(/@.*$/, '').replace(/[^\d]/g, '');
    if (digits) return digits;
  }
  return null;
}
```

- [ ] **Step 4: Update `toWhatsappWebMessage` to include `phoneNumber`**

In the same file, find `toWhatsappWebMessage` (around line 78). Modify it to:

```js
function toWhatsappWebMessage(msg) {
  const remoteJid = msg.key?.remoteJid || null;
  return {
    id: { _serialized: msg.key?.id || null, id: msg.key?.id || null },
    from: remoteJid,
    to: msg.key?.participant || null,
    author: msg.key?.participant || null,
    fromMe: !!msg.key?.fromMe,
    phoneNumber: extractPhoneNumber(msg.key),
    body: textFromBaileysMessage(msg.message || {}),
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : null,
    type: Object.keys(msg.message || {})[0] || 'unknown',
    hasMedia: !!detectMediaPart(msg.message || {}),
    deviceType: 'baileys',
  };
}
```

- [ ] **Step 5: Export `extractPhoneNumber`**

At the bottom of the file, find the existing `module.exports = { ... }` block. Add `extractPhoneNumber` to the exports.

If the file currently has no exports listed (or only the class), add this line at the end:

```js
module.exports.extractPhoneNumber = extractPhoneNumber;
module.exports.toWhatsappWebMessage = toWhatsappWebMessage;
```

Verify by reading the existing exports first (the file already exports `BaileysConnectionManager` and `BaileysPostgresAuthState` — check the file's tail before editing). Both `extractPhoneNumber` and `toWhatsappWebMessage` must be in the exports for downstream tests.

- [ ] **Step 6: Run new tests — verify they pass**

Run: `node --test tests/baileys-extract-phone.test.js`

Expected: 7 PASS.

- [ ] **Step 7: Run the full suite to make sure nothing else broke**

Run: `npm test`

Expected: All previously-passing tests still pass; 7 new tests added on top.

- [ ] **Step 8: Commit**

```bash
git add src/services/whatsapp/baileys-connection-manager.js tests/baileys-extract-phone.test.js
git commit -m "feat(baileys): extract phone number from senderPn for lid messages"
```

---

## Task 3: Ingest — persist phone_number + forward in queue payload

**Files:**
- Modify: `src/services/whatsapp/message-ingest.service.js`
- Create: `tests/message-ingest.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/message-ingest.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

function createFakeDb() {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    transaction: async (fn) => fn({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/RETURNING id, phone_number/.test(sql) && /conversations/.test(sql)) {
          // Echo back the inserted phone_number to simulate the COALESCE returning the persisted value
          return { rows: [{ id: 'conv-1', phone_number: params?.[2] ?? null }] };
        }
        if (/RETURNING id/.test(sql) && /messages/.test(sql)) {
          return { rows: [{ id: 'msg-1' }] };
        }
        return { rows: [] };
      },
    }),
  };
}

test('ingest persists phoneNumber in conversations UPSERT with COALESCE', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm1' },
      from: '276282495500304@lid',
      phoneNumber: '966512345678',
      body: 'مرحبا',
    },
    source: 'baileys',
  });

  const upsert = database.calls.find(c => /INSERT INTO conversations/.test(c.sql));
  assert.ok(upsert, 'conversations UPSERT must run');
  assert.match(upsert.sql, /phone_number/);
  assert.match(upsert.sql, /COALESCE\(conversations\.phone_number, EXCLUDED\.phone_number\)/);
  assert.equal(upsert.params[2], '966512345678', 'phone_number must be the third param');
});

test('ingest forwards phoneNumber into the AI reply queue payload', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm2' },
      from: '276282495500304@lid',
      phoneNumber: '966512345678',
      body: 'hi',
    },
    source: 'baileys',
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.phoneNumber, '966512345678');
});

test('ingest accepts messages without phoneNumber (whatsapp-web.js path) and stores NULL', async () => {
  const enqueued = [];
  const database = createFakeDb();
  const service = new MessageIngestService({
    database,
    logger: { info: () => {} },
    queue: { enqueueAiReply: async (payload, options) => enqueued.push({ payload, options }) },
  });

  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: {
      id: { id: 'm3' },
      from: '966500000000@s.whatsapp.net',
      body: 'hello',
    },
    source: 'whatsapp-web.js',
  });

  const upsert = database.calls.find(c => /INSERT INTO conversations/.test(c.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[2], null);
  assert.equal(enqueued[0].payload.phoneNumber, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/message-ingest.test.js`

Expected: All 3 FAIL — current UPSERT lacks `phone_number` and `phoneNumber` is not in the payload.

- [ ] **Step 3: Add the phoneNumber extraction helper**

In `src/services/whatsapp/message-ingest.service.js`, after `senderFromWhatsappMessage` (around line 34), add:

```js
function phoneNumberFromWhatsappMessage(msg) {
  const raw = String(msg?.phoneNumber || '').trim();
  return raw || null;
}
```

- [ ] **Step 4: Update `upsertConversation` signature + SQL**

Replace the existing function (around lines 52-62):

```js
async function upsertConversation(client, { userId, sender, phoneNumber }) {
  const result = await client.query(
    `INSERT INTO conversations (user_id, sender, phone_number, last_message_at, metadata)
     VALUES ($1, $2, $3, NOW(), '{}'::jsonb)
     ON CONFLICT (user_id, sender) DO UPDATE SET
       last_message_at = NOW(),
       phone_number = COALESCE(conversations.phone_number, EXCLUDED.phone_number)
     RETURNING id, phone_number`,
    [userId, sender, phoneNumber],
  );
  return { id: result.rows[0].id, phoneNumber: result.rows[0].phone_number };
}
```

- [ ] **Step 5: Update `ingestWhatsappMessage` to pass + forward phoneNumber**

In the same file, replace the body of `ingestWhatsappMessage` (around lines 101-152) — keeping the same overall logic but threading `phoneNumber` through:

```js
  async ingestWhatsappMessage({ userId, msg, source = 'whatsapp-web.js' }) {
    if (!userId) throw new Error('userId is required');
    if (this.shouldIgnore(msg)) {
      return { accepted: false, statusCode: 200, reason: 'ignored' };
    }
    if (!this.db.isConfigured()) {
      throw new Error('DATABASE_URL is required for message ingest');
    }

    const sender = senderFromWhatsappMessage(msg);
    const phoneNumber = phoneNumberFromWhatsappMessage(msg);
    const text = contentFromWhatsappMessage(msg);
    const media = mediaFromWhatsappMessage(msg);
    const providerMessageId = messageIdFromWhatsappMessage(msg) || `${userId}:${sender}:${Date.now()}`;
    const rawPayload = { source, ...toSafeRawPayload(msg) };

    const saved = await this.db.transaction(async (client) => {
      const { id: conversationId, phoneNumber: storedPhoneNumber } = await upsertConversation(client, {
        userId,
        sender,
        phoneNumber,
      });
      const messageId = await insertInboundMessage(client, {
        userId,
        conversationId,
        sender,
        text,
        providerMessageId,
        rawPayload,
      });
      return { conversationId, messageId, phoneNumber: storedPhoneNumber };
    });

    await this.queue.enqueueAiReply({
      userId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
      sender,
      phoneNumber: saved.phoneNumber,
      text,
      providerMessageId,
      source,
      hasMedia: !!media,
      media,
    }, {
      jobKey: `conversation-${saved.conversationId}`,
    });

    this.logger.info?.('message', `queued inbound message ${providerMessageId} from ${sender}`);
    return {
      accepted: true,
      statusCode: 200,
      userId,
      sender,
      providerMessageId,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
    };
  }
```

- [ ] **Step 6: Run the new tests — verify they pass**

Run: `node --test tests/message-ingest.test.js`

Expected: 3 PASS.

- [ ] **Step 7: Run the existing ingest test to ensure no regression**

Run: `node --test tests/message-ingest-media.test.js`

Expected: PASS (the media test uses a regex `/RETURNING id/` which still matches `RETURNING id, phone_number`. The fake DB returns `{ id: 'conv-1' }` without `phone_number` — `result.rows[0].phone_number` is `undefined`, which becomes `null` after our destructure-default. No breakage.)

- [ ] **Step 8: Run the full suite**

Run: `npm test`

Expected: all previous tests still pass + 3 new tests added.

- [ ] **Step 9: Commit**

```bash
git add src/services/whatsapp/message-ingest.service.js tests/message-ingest.test.js
git commit -m "feat(ingest): persist phoneNumber via UPSERT and forward in queue payload"
```

---

## Task 4: AI worker — load + forward phone_number to escalation

**Files:**
- Modify: `src/workers/ai-worker.js`

- [ ] **Step 1: Locate the conversation SELECT (around line 97)**

Find the line:

```js
'SELECT id, sender FROM conversations WHERE id = $1 AND user_id = $2',
```

Replace with:

```js
'SELECT id, sender, phone_number FROM conversations WHERE id = $1 AND user_id = $2',
```

- [ ] **Step 2: Update the `prepareEscalation` call (around line 453)**

Find:

```js
    const escalation = prepareEscalation({
      reply,
      config,
      customerSender: conversation.sender,
      inboundText: text,
    });
```

Replace with:

```js
    const escalation = prepareEscalation({
      reply,
      config,
      customerSender: conversation.sender,
      customerPhoneNumber: conversation.phone_number,
      inboundText: text,
    });
```

- [ ] **Step 3: Update the escalation `enqueueOutgoingWhatsapp` call (around line 487)**

Find:

```js
    if (escalation.ownerMessage) {
      await enqueueOutgoingWhatsapp({
        userId,
        conversationId: conversation.id,
        messageId: payload.messageId,
        providerMessageId: payload.providerMessageId,
        sender: escalation.ownerMessage.sender,
        reply: escalation.ownerMessage.reply,
        escalation: true,
        escalationSummary: escalation.ownerMessage.summary,
        customerSender: conversation.sender,
      }, {
        jobKey: buildEscalationJobKey(replyMessageId),
      });
    }
```

Add `customerPhoneNumber: conversation.phone_number,` right after `customerSender:`:

```js
    if (escalation.ownerMessage) {
      await enqueueOutgoingWhatsapp({
        userId,
        conversationId: conversation.id,
        messageId: payload.messageId,
        providerMessageId: payload.providerMessageId,
        sender: escalation.ownerMessage.sender,
        reply: escalation.ownerMessage.reply,
        escalation: true,
        escalationSummary: escalation.ownerMessage.summary,
        customerSender: conversation.sender,
        customerPhoneNumber: conversation.phone_number,
      }, {
        jobKey: buildEscalationJobKey(replyMessageId),
      });
    }
```

- [ ] **Step 4: Smoke check that the file still parses**

Run: `node -e "require('./src/workers/ai-worker.js'); console.log('ok')"`

Expected: `ok` (no syntax error). The require may emit logs/warnings about missing config — that's fine; we only care about parsing.

- [ ] **Step 5: Run the full suite — verify no regression**

Run: `npm test`

Expected: all previously-passing tests still pass. (The ai-worker tests use fake DBs whose mock query results need to include `phone_number`. They typically set up their own fake row objects, and missing properties become `undefined`, which is harmless when forwarded as `customerPhoneNumber`.)

- [ ] **Step 6: Commit**

```bash
git add src/workers/ai-worker.js
git commit -m "feat(ai-worker): load and forward conversation.phone_number to escalation"
```

---

## Task 5: Escalation routing — prefer phoneNumber over lid

**Files:**
- Modify: `src/workers/escalation-routing.js`
- Modify: `tests/escalation-routing.test.js`

- [ ] **Step 1: Append failing tests to `tests/escalation-routing.test.js`**

At the bottom of `tests/escalation-routing.test.js`, append:

```js
test('buildEscalationNotification prefers customerPhoneNumber over lid sender', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    customerPhoneNumber: '966512345678',
    inboundText: 'مشكلة في الطلب',
    summary: 'طلب لم يصل',
  });
  assert.ok(text.includes('+966512345678'), 'must include the real phone, got: ' + text);
  assert.ok(!text.includes('@lid'), 'must NOT include the lid');
});

test('buildEscalationNotification falls back to sender when customerPhoneNumber is missing', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  // No phoneNumber → existing behavior: lid leaks through (acceptable for old conversations).
  assert.ok(text.includes('276282495500304@lid'));
});

test('prepareEscalation threads customerPhoneNumber into the owner notification', () => {
  const config = {
    escalationContacts: [{ name: 'علي', role: 'دعم', phone: '966500000000' }],
  };
  const result = prepareEscalation({
    reply: 'ثواني اتأكد لك [تحويل:علي|مشكلة دفع]',
    config,
    customerSender: '276282495500304@lid',
    customerPhoneNumber: '966512345678',
    inboundText: 'ما اقدر ادفع',
  });
  assert.ok(result.ownerMessage, 'escalation must produce an owner message');
  assert.ok(result.ownerMessage.reply.includes('+966512345678'));
  assert.ok(!result.ownerMessage.reply.includes('@lid'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/escalation-routing.test.js`

Expected: 3 new FAIL — `customerPhoneNumber` is not yet honored.

- [ ] **Step 3: Update `cleanCustomerJid`**

In `src/workers/escalation-routing.js`, find `cleanCustomerJid` (around line 79):

```js
function cleanCustomerJid(sender) {
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  return cleanDigits(sender) || String(sender || '').trim();
}
```

Replace with:

```js
function cleanCustomerJid(sender, { phoneNumber } = {}) {
  const pn = String(phoneNumber || '').trim();
  if (pn) return `+${pn}`;
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  return cleanDigits(sender) || raw;
}
```

- [ ] **Step 4: Update `buildEscalationNotification`**

Find `buildEscalationNotification` (around line 91):

```js
function buildEscalationNotification({ contact, customerSender, inboundText, summary }) {
  const customer = cleanCustomerJid(customerSender);
  // ... rest unchanged
```

Replace the signature and the first line of the body:

```js
function buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }) {
  const customer = cleanCustomerJid(customerSender, { phoneNumber: customerPhoneNumber });
  // ... rest unchanged
```

The remainder of the function (template application, fallback string building) stays exactly as it is.

- [ ] **Step 5: Update `prepareEscalation`**

Find `prepareEscalation` (around line 115):

```js
function prepareEscalation({ reply, config = {}, customerSender, inboundText }) {
```

Replace the signature with:

```js
function prepareEscalation({ reply, config = {}, customerSender, customerPhoneNumber, inboundText }) {
```

Then find the call inside the function body that builds the notification:

```js
      reply: buildEscalationNotification({ contact, customerSender, inboundText, summary }),
```

Replace with:

```js
      reply: buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }),
```

- [ ] **Step 6: Run the escalation tests — verify they pass**

Run: `node --test tests/escalation-routing.test.js`

Expected: all previous tests pass + 3 new tests pass.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/workers/escalation-routing.js tests/escalation-routing.test.js
git commit -m "feat(escalation): prefer customerPhoneNumber over lid in owner notifications"
```

---

## Task 6: Conversations controller — surface phone_number in dashboard

**Files:**
- Modify: `src/controllers/conversations.controller.js`
- Modify: `tests/conversations-controller.test.js`

- [ ] **Step 1: Append failing tests to `tests/conversations-controller.test.js`**

At the bottom of the file, append:

```js
test('cleanCustomerPhone returns +<digits> when row.phone_number is present', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: '966512345678', sender: '276282495500304@lid' }),
    '+966512345678'
  );
});

test('cleanCustomerPhone falls back to sender behavior when phone_number is null', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '276282495500304@lid' }),
    '276282495500304@lid'
  );
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '966500000000@s.whatsapp.net' }),
    '+966500000000'
  );
});

test('cleanCustomerPhone preserves the string-only signature for backward compat', () => {
  assert.equal(cleanCustomerPhone('966500000000@s.whatsapp.net'), '+966500000000');
  assert.equal(cleanCustomerPhone('276282495500304@lid'), '276282495500304@lid');
});

test('conversations controller list includes phone_number in SELECT and exposes phoneNumber in payload', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1, ongoing: 1, finished: 0 }] };
      if (/FROM conversations c/.test(sql)) {
        return {
          rows: [{
            id: 'conv-1',
            sender: '276282495500304@lid',
            phone_number: '966512345678',
            last_message_at: new Date().toISOString(),
            first_inquiry: 'ابي السعر',
          }],
        };
      }
      return { rows: [] };
    },
  };
  const ctl = createConversationsController({ database });
  let body = null;
  const req = { session: { userId: 'u1' }, query: {} };
  const res = { json: (p) => { body = p; } };
  await ctl.list(req, res);

  const listQuery = calls.find(c => /FROM conversations c/.test(c.sql));
  assert.match(listQuery.sql, /c\.phone_number/);
  assert.equal(body.conversations[0].phoneNumber, '966512345678');
  assert.equal(body.conversations[0].phone, '+966512345678');
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node --test tests/conversations-controller.test.js`

Expected: 4 new FAIL.

- [ ] **Step 3: Update `cleanCustomerPhone` to accept a row**

In `src/controllers/conversations.controller.js`, replace the existing function (lines 12-17):

```js
function cleanCustomerPhone(sender) {
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  const digits = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}
```

With:

```js
function cleanCustomerPhone(senderOrRow) {
  if (senderOrRow && typeof senderOrRow === 'object') {
    const pn = String(senderOrRow.phone_number || '').trim();
    if (pn) return `+${pn}`;
    return cleanCustomerPhone(senderOrRow.sender);
  }
  const raw = String(senderOrRow || '').trim();
  if (raw.endsWith('@lid')) return raw;
  const digits = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}
```

- [ ] **Step 4: Update the list SELECT to include `c.phone_number`**

In the same file, find the list query (around lines 93-112):

```js
        database.query(
          `SELECT c.id,
                  c.sender,
                  c.last_message_at,
                  COALESCE(first_msg.content, '') AS first_inquiry
           FROM conversations c
           LEFT JOIN LATERAL (
             ...
```

Add `c.phone_number,` between `c.sender,` and `c.last_message_at,`:

```js
        database.query(
          `SELECT c.id,
                  c.sender,
                  c.phone_number,
                  c.last_message_at,
                  COALESCE(first_msg.content, '') AS first_inquiry
           FROM conversations c
           LEFT JOIN LATERAL (
             ...
```

- [ ] **Step 5: Update the payload to expose `phoneNumber` and use the row in `cleanCustomerPhone`**

Still in the same file, find the payload mapping (around lines 132-140):

```js
      const payload = conversations.rows.map(row => ({
        id: row.id,
        sender: row.sender,
        phone: cleanCustomerPhone(row.sender),
        title: buildConversationTitle(row.first_inquiry),
        lastMessageAt: row.last_message_at,
        status: classifyConversation(row.last_message_at, { now }),
        messages: messagesByConversation.get(row.id) || [],
      }));
```

Replace with:

```js
      const payload = conversations.rows.map(row => ({
        id: row.id,
        sender: row.sender,
        phoneNumber: row.phone_number || null,
        phone: cleanCustomerPhone(row),
        title: buildConversationTitle(row.first_inquiry),
        lastMessageAt: row.last_message_at,
        status: classifyConversation(row.last_message_at, { now }),
        messages: messagesByConversation.get(row.id) || [],
      }));
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `node --test tests/conversations-controller.test.js`

Expected: all previous tests pass + 4 new tests pass.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/conversations.controller.js tests/conversations-controller.test.js
git commit -m "feat(dashboard): surface conversations.phone_number in the API payload"
```

---

## Task 7: Final regression sweep + push + PR

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`

Expected: all tests pass. Document the count.

- [ ] **Step 2: Manual sanity check on the key files**

Run:

```bash
node -e "const m=require('./src/services/whatsapp/baileys-connection-manager'); if(typeof m.extractPhoneNumber!=='function')throw new Error('extractPhoneNumber not exported'); console.log('baileys ok');"
node -e "const m=require('./src/services/whatsapp/message-ingest.service'); if(!m.MessageIngestService)throw new Error('MessageIngestService not exported'); console.log('ingest ok');"
node -e "const m=require('./src/controllers/conversations.controller'); if(typeof m.cleanCustomerPhone!=='function')throw new Error('cleanCustomerPhone not exported'); if(m.cleanCustomerPhone({phone_number:'966',sender:'x@lid'})!=='+966')throw new Error('row form broken'); console.log('controller ok');"
node -e "const m=require('./src/workers/escalation-routing'); const out=m.buildEscalationNotification({contact:{name:'x'},customerSender:'276@lid',customerPhoneNumber:'966512345678',inboundText:'hi',summary:'s'}); if(!out.includes('+966512345678'))throw new Error('escalation does not use phoneNumber'); console.log('escalation ok');"
```

Expected: 4 lines of `ok`.

- [ ] **Step 3: Confirm migration syntax**

Run:

```bash
node -e "const stmts=require('./src/db/migrations/init.js'); /* the file may export statements OR run as a script. If it's a script with side-effects, this require() is enough to surface syntax errors. */ console.log('migration parseable');"
```

If the migration file's module exports nothing (script-style), running with `node -e "require(...)"` may attempt to connect to DB. In that case, parse-check only:

```bash
node --check src/db/migrations/init.js && echo "migration syntax ok"
```

Expected: `migration syntax ok`.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin claude/amazing-galileo-e47eaf
```

- [ ] **Step 5: Open the PR with `gh`**

```bash
gh pr create --base master --title "feat: extract real phone number from senderPn (lid fix)" --body "$(cat <<'EOF'
## ملخص

إصلاح مشكلة ظهور `@lid` بدل رقم العميل الحقيقي في الـ dashboard وإشعارات التصعيد. الـ Baileys يكشف الرقم الحقيقي عبر `message.key.senderPn` حتى لو الـ remoteJid هو معرّف lid مجهول. نضيف عمود `phone_number` على `conversations`، نملأه من ingest عبر UPSERT بـ COALESCE، ونستخدمه في الواجهة + التصعيد.

## التغييرات

### Backend
- Migration: `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT` (idempotent)
- `baileys-connection-manager.js`: helper جديد `extractPhoneNumber(key)` + `toWhatsappWebMessage` يضيف `phoneNumber` للـ payload
- `message-ingest.service.js`: `upsertConversation` يحفظ `phone_number` مع COALESCE (immutable per conversation)، الـ `enqueueAiReply` يمرّر phoneNumber
- `ai-worker.js`: SELECT للمحادثة يحوي `phone_number`، يُمرَّر لـ `prepareEscalation` كـ `customerPhoneNumber`
- `escalation-routing.js`: `cleanCustomerJid` و `buildEscalationNotification` يفضّلان phoneNumber لو موجود

### Frontend (API contract فقط — لا تغيير HTML/CSS)
- `conversations.controller.js`: SELECT يحوي `c.phone_number`، الـ payload يعرض `phoneNumber` + `cleanCustomerPhone` يقبل row

## ما لا يتغيّر
- لا backfill — المحادثات القديمة تبقى بـ phone_number = NULL وتظهر بالـ lid (للحفاظ على التوافق)
- الـ `sender` (الـ lid) يبقى كما هو في DB ويُستخدم للإرسال (Baileys يفهمه)
- لا تغيير في HTML/CSS الـ dashboard

## Test plan

- [ ] رسالة جديدة من جهاز iOS بـ lid → في DB: `phone_number = '966xxxxxxxxx'`
- [ ] بطاقة المحادثة في الـ dashboard تعرض `+966xxxxxxxxx` بدل `xxx@lid`
- [ ] header المحادثة المفتوحة يعرض الرقم الحقيقي
- [ ] إشعار التصعيد للمالك يحوي `+966xxxxxxxxx` (ليس `xxx@lid`)
- [ ] المحادثات القديمة (بـ lid فقط) تظهر بنفس الشكل القديم (no regression)
- [ ] رسالة من رقم عادي (`@s.whatsapp.net`) → phoneNumber يُستخرج من remoteJid

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Output the PR URL**

After `gh pr create` succeeds, print the URL it returned. Report it back to the user.

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks covering it |
|---|---|
| §3 data flow | Tasks 2 (Baileys), 3 (ingest), 4 (worker), 5 (escalation), 6 (controller) |
| §4.1 migration | Task 1 |
| §4.2 baileys helper | Task 2 |
| §4.3 ingest UPSERT | Task 3 |
| §4.4 ai-worker | Task 4 |
| §4.5 escalation routing | Task 5 |
| §4.6 conversations controller | Task 6 |
| §5.1 baileys-extract-phone tests | Task 2 |
| §5.2 message-ingest tests | Task 3 |
| §5.3 controller tests | Task 6 |
| §5.4 escalation tests | Task 5 |
| §5.5 ai-worker tests | Not needed (spec acknowledged this) |
| §6 backward compat | All tasks preserve fallback to old behavior |
| §7 rollback | Tested implicitly — every change has a null-safe fallback |

**Placeholder scan:** No TBD/TODO. Every step shows the exact code or command.

**Type consistency:**
- `phoneNumber` (camelCase) used everywhere in JS payloads and function params.
- `phone_number` (snake_case) used only at the DB column boundary.
- `cleanCustomerJid(sender, { phoneNumber })` and `cleanCustomerPhone(row|string)` — backward compatible polymorphic signatures with consistent option-bag naming.

**No-break check:** Every existing test continues to pass because:
- The migration is purely additive (NULL by default).
- The `RETURNING id, phone_number` clause still matches existing fake-DB regex `/RETURNING id/`.
- `cleanCustomerPhone('string')` still works as before.
- `cleanCustomerJid(sender)` (no options) still works as before.
- `prepareEscalation` and `buildEscalationNotification` accept an extra optional field; existing callers in `ai-worker.js` are updated in the same task.

**Frequency of `npm test`:** every task ends with `npm test` to catch any cross-file regression early.
