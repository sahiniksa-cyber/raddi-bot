# Instagram DM Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully isolated Instagram DM auto-reply system to the existing "ردّي" platform, running beside WhatsApp — separate tables, queues, workers, routes, and dashboard pages — so any Instagram failure can never affect WhatsApp, while reusing the shared AI brain and the shared message quota.

**Architecture:** A parallel channel module under `src/services/instagram/` and `src/workers/instagram-worker.js`, gated behind `INSTAGRAM_ENABLED` (default OFF). It mirrors the proven WhatsApp pipeline (webhook → incoming queue → worker → AI → outgoing queue → send) but uses Meta's official **Instagram API with Instagram Login** (OAuth + Graph webhooks) instead of Baileys. The AI generation (`lib/ai-client.js`), quota functions (`src/services/billing/message-quota.js`), secrets (`src/services/security/secrets.js`), and config shape are reused unchanged. Instagram AI settings live in their own table and are **seeded (copied) from the merchant's WhatsApp config on first open** so the merchant only edits, never starts from scratch — but stored separately so edits never touch WhatsApp.

**Tech Stack:** Node.js, Express, PostgreSQL (`pg`, raw SQL), BullMQ + Redis, Meta Graph API `graph.instagram.com` (v25.0), AES-256-GCM secrets, plain HTML/vanilla-JS dashboard.

**Non-negotiable requirements (from the product owner):**
1. **Total isolation** — an Instagram error must never break WhatsApp (separate tables/queues/workers/routes; feature flag default OFF; every Instagram code path wrapped so it fails alone).
2. **Shared quota** — every Instagram reply sent to a customer decrements the same `billing_accounts` quota via the existing `decrementMessageQuota(userId)`.
3. **Seeded settings** — the Instagram settings page is pre-filled from the merchant's WhatsApp config on first load; the merchant edits a copy stored separately.

---

## Meta API facts this plan depends on (verified 2026-07-08, post-Jan-2025 docs)

- Path: **Instagram API with Instagram Login** (no Facebook Page needed). Hosts: `www.instagram.com` / `api.instagram.com` / `graph.instagram.com`.
- Scopes (current): `instagram_business_basic`, `instagram_business_manage_messages`.
- Authorize: `GET https://www.instagram.com/oauth/authorize?client_id=&redirect_uri=&response_type=code&scope=instagram_business_basic,instagram_business_manage_messages&state=`
- Code → short-lived token: `POST https://api.instagram.com/oauth/access_token` (form: client_id, client_secret, grant_type=authorization_code, redirect_uri, code). Response `{ data:[{ access_token, user_id, permissions }] }`. Valid 1h.
- Short → long-lived: `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=&access_token=`. Response `{ access_token, token_type, expires_in }` (~60 days).
- Refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=`. Token must be ≥24h old and refreshed within 60 days or the user must re-authorize.
- Subscribe to DMs: `POST https://graph.instagram.com/me/subscribed_apps?subscribed_fields=messages&access_token=<LONG_LIVED>`.
- Webhook verify handshake (GET): echo back `hub.challenge` as plain text with 200 if `hub.verify_token` matches.
- Incoming DM POST: `{ object:"instagram", entry:[{ id, time, messaging:[{ sender:{id:<IGSID>}, recipient:{id}, timestamp, message:{ mid, text } }] }] }`.
- Signature: header `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the **raw** body with the App Secret.
- Send DM: `POST https://graph.instagram.com/v25.0/me/messages` body `{ recipient:{id:<IGSID>}, message:{ text } }` using the account's long-lived token. Response `{ recipient_id, message_id }`.
- 24h standard window (resets on each customer message). Human-agent tag extends to 7 days (`messaging_type:"MESSAGE_TAG", tag:"HUMAN_AGENT"`) — deferred past MVP.
- Dev/testing: **Standard Access** (default) lets you fully test on your OWN IG professional account and accounts with a role on the app, with **no App Review**. Selling to customers' own accounts needs **Advanced Access + App Review + Business Verification** — a business/ops gate, not a code gate; out of scope for this build.

---

## File Structure

**New files (all Instagram-only; deleting them removes the feature):**

| File | Responsibility |
|------|----------------|
| `src/services/instagram/instagram-config.js` | Reads/writes `instagram_ai_settings`; seeds from `bot_configs` on first read; the shared config shape lives in `lib/constants.js` (reused). |
| `src/services/instagram/instagram-accounts.js` | CRUD for `instagram_accounts`; stores/reads the long-lived token encrypted via `secrets.js`. |
| `src/services/instagram/instagram-oauth.js` | Pure functions: build authorize URL, exchange code→short, short→long, refresh. No Express. |
| `src/services/instagram/instagram-graph.js` | Thin Graph API client: `sendDirectMessage`, `subscribeToMessages`, `getProfile`. |
| `src/services/instagram/instagram-signature.js` | `verifyInstagramSignature(rawBody, header, appSecret)` (constant-time HMAC). |
| `src/services/instagram/instagram-ingest.js` | Normalizes a webhook entry → internal message; upserts conversation + inbound message; enqueues AI. Instagram analog of `message-ingest.service.js`. |
| `src/services/instagram/instagram-logs.js` | `logInstagram(userId, level, eventType, detail)` → `instagram_logs`. |
| `src/queues/instagram-queue.js` | BullMQ queues `incoming-instagram` + `outgoing-instagram` and enqueue helpers. Separate from `message-queue.js`. |
| `src/workers/instagram-worker.js` | Worker process: registers the incoming worker (store → AI via `ai-client` → enqueue outgoing) and the outgoing worker (quota check → Graph send → quota decrement). |
| `src/routes/instagram.routes.js` | `createInstagramRoutes(deps)`: OAuth connect/callback, webhook (raw body + signature), status/disconnect, config GET/POST, inbox list/messages/manual-send, AI toggle. |
| `src/controllers/instagram.controller.js` | Handlers used by the routes (thin; delegate to services). |
| `dashboard/instagram.js` | Front-end logic for the Instagram tab (loaded by `index.html`). |
| `test/instagram/*.test.js` | Unit + integration tests for every logic unit below. |

**Modified files (minimal, additive, guarded):**

| File | Change |
|------|--------|
| `src/db/migrations/init.js` | Append the 5 `instagram_*` tables + indexes + triggers (idempotent). |
| `src/queues/message-queue.js` | No change (Instagram queues live in their own file). |
| `src/runtime/start-all.js` | Add an `instagram-worker` process entry, spawned only when `INSTAGRAM_ENABLED==='true'`. |
| `src/routes/index.js` | Mount `createInstagramRoutes(deps)` (route file self-guards on the flag). |
| `src/server.js` | Add `/instagram/webhook` to `RAW_BODY_PATHS`; mount Instagram routes; start the Instagram token-refresh timer only when flag is ON. |
| `dashboard/index.html` | Add an `Instagram` nav tab + `#view-instagram` container + `<script src="/dashboard/instagram.js">`. WhatsApp markup untouched. |

**Isolation invariant (enforced in every task):** No file in `src/services/whatsapp/`, `src/workers/ai-worker.js`, or `src/workers/outgoing-whatsapp-worker.js` is modified. Instagram never imports Baileys. Shared modules used read-only: `lib/ai-client.js`, `src/services/billing/message-quota.js`, `src/services/security/secrets.js`, `lib/constants.js`, `src/db/client.js`.

---

## Environment variables (documented in Task 1)

| Var | Default | Purpose |
|-----|---------|---------|
| `INSTAGRAM_ENABLED` | `false` | Master switch. Everything Instagram is a no-op unless `'true'`. |
| `INSTAGRAM_APP_ID` | — | Meta App ID. |
| `INSTAGRAM_APP_SECRET` | — | Meta App Secret (also HMAC key for webhook). Set in Railway, never in chat/repo. |
| `INSTAGRAM_REDIRECT_URI` | — | OAuth redirect, e.g. `https://<app>/instagram/auth/callback`. Must match dashboard exactly. |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | — | Random string; matched in the GET handshake. |
| `INSTAGRAM_GRAPH_VERSION` | `v25.0` | Pinned Graph version. |
| `INCOMING_INSTAGRAM_QUEUE` | `incoming-instagram` | Queue name. |
| `OUTGOING_INSTAGRAM_QUEUE` | `outgoing-instagram` | Queue name. |
| `INSTAGRAM_WORKER_CONCURRENCY` | `2` | Incoming worker concurrency. |
| `INSTAGRAM_TOKEN_REFRESH_INTERVAL_MS` | `86400000` | Daily token-refresh sweep. |

---

# PHASE 2 — Database (isolated tables)

### Task 1: Instagram tables migration

**Files:**
- Modify: `src/db/migrations/init.js` (append to the `statements` array, before `migrate()`)
- Test: `test/instagram/migration.test.js`

- [ ] **Step 1: Write the failing test** (verifies the migration SQL strings exist and are well-formed; no live DB needed)

```javascript
// test/instagram/migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const initSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'db', 'migrations', 'init.js'),
  'utf8',
);

test('migration declares all instagram_* tables idempotently', () => {
  for (const table of [
    'instagram_accounts',
    'instagram_ai_settings',
    'instagram_conversations',
    'instagram_messages',
    'instagram_logs',
  ]) {
    assert.ok(
      initSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      `missing CREATE TABLE IF NOT EXISTS ${table}`,
    );
  }
});

test('instagram_messages dedup + conversation uniqueness indexes present', () => {
  assert.ok(initSrc.includes('idx_instagram_messages_user_provider_unique'));
  assert.ok(initSrc.includes('idx_instagram_conversations_user_participant'));
});

test('instagram tables never reference whatsapp tables', () => {
  // guard: the instagram block must not accidentally FK into whatsapp_sessions
  const block = initSrc.slice(initSrc.indexOf('instagram_accounts'));
  assert.ok(!block.includes('whatsapp_sessions'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/instagram/migration.test.js`
Expected: FAIL (strings not found yet).

- [ ] **Step 3: Append the migration statements** to the `statements` array in `src/db/migrations/init.js` (immediately after the last existing table string, before the closing `]`). Follow the existing idempotent pattern (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER ... EXECUTE FUNCTION set_updated_at()`).

```javascript
  // ---------- Instagram module (isolated; safe to drop wholesale) ----------
  `CREATE TABLE IF NOT EXISTS instagram_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ig_user_id TEXT,
    ig_username TEXT,
    access_token_encrypted TEXT,
    access_token_iv TEXT,
    access_token_tag TEXT,
    access_token_format TEXT DEFAULT 'aes-256-gcm',
    access_token_plain TEXT,
    token_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'disconnected',
    connected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS instagram_ai_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    seeded_from_whatsapp BOOLEAN NOT NULL DEFAULT false,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS instagram_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL,
    participant_username TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_message_at TIMESTAMPTZ,
    escalated_until TIMESTAMPTZ,
    window_expires_at TIMESTAMPTZ,
    ai_paused BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, participant_id)
  )`,
  `CREATE TABLE IF NOT EXISTS instagram_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES instagram_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'stored',
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS instagram_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    event_type TEXT,
    detail JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_instagram_conversations_user_last
    ON instagram_conversations (user_id, last_message_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversations_user_participant
    ON instagram_conversations (user_id, participant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_instagram_messages_conversation_created
    ON instagram_messages (conversation_id, created_at ASC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_messages_user_provider_unique
    ON instagram_messages (user_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_instagram_logs_user_created
    ON instagram_logs (user_id, created_at DESC)`,
  `DROP TRIGGER IF EXISTS trg_instagram_accounts_updated_at ON instagram_accounts`,
  `CREATE TRIGGER trg_instagram_accounts_updated_at
    BEFORE UPDATE ON instagram_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
  `DROP TRIGGER IF EXISTS trg_instagram_conversations_updated_at ON instagram_conversations`,
  `CREATE TRIGGER trg_instagram_conversations_updated_at
    BEFORE UPDATE ON instagram_conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
```

> Note: `access_token_plain` mirrors the existing `customer_api_keys` fallback (used only when `SECRETS_KEY` is unset in dev); production always encrypts.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/instagram/migration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/init.js test/instagram/migration.test.js
git commit -m "feat(instagram): add isolated instagram_* tables migration"
```

**Risk:** 🟢 Low (additive, idempotent, no FK into WhatsApp). **Time:** ~1h.

---

# PHASE 1/3 — Foundation: flag, secrets-backed accounts, config seeding

### Task 2: Instagram accounts store (encrypted tokens)

**Files:**
- Create: `src/services/instagram/instagram-accounts.js`
- Test: `test/instagram/instagram-accounts.test.js`

- [ ] **Step 1: Write the failing test** (pure token encode/decode using injected fakes; no DB)

```javascript
// test/instagram/instagram-accounts.test.js
const test = require('node:test');
const assert = require('node:assert');
const { encodeToken, decodeToken } = require('../../src/services/instagram/instagram-accounts');

test('encodeToken uses secrets.encrypt when available', () => {
  const fakeSecrets = {
    isEncryptionAvailable: () => true,
    encrypt: (pt) => ({ ciphertext: 'C:' + pt, iv: 'IV', tag: 'TAG' }),
  };
  const row = encodeToken('tok123', { secrets: fakeSecrets });
  assert.deepStrictEqual(row, {
    access_token_encrypted: 'C:tok123',
    access_token_iv: 'IV',
    access_token_tag: 'TAG',
    access_token_plain: null,
  });
});

test('encodeToken falls back to plaintext when encryption unavailable', () => {
  const fakeSecrets = { isEncryptionAvailable: () => false };
  const row = encodeToken('tok123', { secrets: fakeSecrets });
  assert.strictEqual(row.access_token_plain, 'tok123');
  assert.strictEqual(row.access_token_encrypted, null);
});

test('decodeToken round-trips encrypted', () => {
  const fakeSecrets = { decrypt: ({ ciphertext }) => ciphertext.replace('C:', '') };
  const tok = decodeToken(
    { access_token_encrypted: 'C:tok123', access_token_iv: 'IV', access_token_tag: 'TAG', access_token_plain: null },
    { secrets: fakeSecrets },
  );
  assert.strictEqual(tok, 'tok123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/instagram/instagram-accounts.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `instagram-accounts.js`** reusing `src/services/security/secrets.js` (`encrypt`/`decrypt`/`isEncryptionAvailable`).

```javascript
// src/services/instagram/instagram-accounts.js
const db = require('../../db/client');
const defaultSecrets = require('../security/secrets');

function encodeToken(token, { secrets = defaultSecrets } = {}) {
  if (secrets.isEncryptionAvailable()) {
    const { ciphertext, iv, tag } = secrets.encrypt(token);
    return { access_token_encrypted: ciphertext, access_token_iv: iv, access_token_tag: tag, access_token_plain: null };
  }
  return { access_token_encrypted: null, access_token_iv: null, access_token_tag: null, access_token_plain: token };
}

function decodeToken(row, { secrets = defaultSecrets } = {}) {
  if (!row) return null;
  if (row.access_token_encrypted) {
    return secrets.decrypt({
      ciphertext: row.access_token_encrypted,
      iv: row.access_token_iv,
      tag: row.access_token_tag,
    });
  }
  return row.access_token_plain || null;
}

async function upsertAccount(userId, { igUserId, igUsername, token, expiresAt }, deps = {}) {
  const database = deps.database || db;
  const t = encodeToken(token, deps);
  const res = await database.query(
    `INSERT INTO instagram_accounts
       (user_id, ig_user_id, ig_username, access_token_encrypted, access_token_iv,
        access_token_tag, access_token_plain, token_expires_at, status, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'connected',NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       ig_user_id=EXCLUDED.ig_user_id, ig_username=EXCLUDED.ig_username,
       access_token_encrypted=EXCLUDED.access_token_encrypted, access_token_iv=EXCLUDED.access_token_iv,
       access_token_tag=EXCLUDED.access_token_tag, access_token_plain=EXCLUDED.access_token_plain,
       token_expires_at=EXCLUDED.token_expires_at, status='connected', connected_at=NOW()
     RETURNING id`,
    [userId, igUserId, igUsername, t.access_token_encrypted, t.access_token_iv,
     t.access_token_tag, t.access_token_plain, expiresAt],
  );
  return res.rows[0];
}

async function getAccount(userId, deps = {}) {
  const database = deps.database || db;
  const res = await database.query('SELECT * FROM instagram_accounts WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function getAccountToken(userId, deps = {}) {
  const row = await getAccount(userId, deps);
  return decodeToken(row, deps);
}

async function disconnectAccount(userId, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `UPDATE instagram_accounts
       SET status='disconnected', access_token_encrypted=NULL, access_token_iv=NULL,
           access_token_tag=NULL, access_token_plain=NULL
     WHERE user_id=$1`,
    [userId],
  );
}

async function listConnectedAccounts(deps = {}) {
  const database = deps.database || db;
  const res = await database.query(`SELECT * FROM instagram_accounts WHERE status='connected'`);
  return res.rows;
}

module.exports = {
  encodeToken, decodeToken, upsertAccount, getAccount, getAccountToken,
  disconnectAccount, listConnectedAccounts,
};
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/instagram/instagram-accounts.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/instagram/instagram-accounts.js test/instagram/instagram-accounts.test.js
git commit -m "feat(instagram): account store with encrypted long-lived tokens"
```

**Risk:** 🟡 Medium (token handling). **Time:** ~1.5h.

---

### Task 3: Instagram config store with WhatsApp seeding

**Files:**
- Create: `src/services/instagram/instagram-config.js`
- Test: `test/instagram/instagram-config.test.js`

This implements requirement #3: on first read, copy the merchant's WhatsApp config (`bot_configs.config`) into `instagram_ai_settings.config`, then serve/edit the copy.

- [ ] **Step 1: Write the failing test** (seeding logic with injected DB)

```javascript
// test/instagram/instagram-config.test.js
const test = require('node:test');
const assert = require('node:assert');
const { seedConfigFromWhatsapp, resolveInstagramConfig } = require('../../src/services/instagram/instagram-config');

function fakeDb(rowsByQuery) {
  return { query: async (sql) => {
    for (const [needle, rows] of rowsByQuery) if (sql.includes(needle)) return { rows };
    return { rows: [] };
  } };
}

test('seedConfigFromWhatsapp copies bot_configs.config verbatim', () => {
  const wa = { storeName: 'متجري', replyStyle: { employeeName: 'محمد', emojiLevel: 'heavy' }, botInstructions: 'كن ودود' };
  const seeded = seedConfigFromWhatsapp(wa);
  assert.strictEqual(seeded.storeName, 'متجري');
  assert.strictEqual(seeded.replyStyle.employeeName, 'محمد');
  assert.strictEqual(seeded.botInstructions, 'كن ودود');
});

test('seedConfigFromWhatsapp on empty WA config returns defaults, never throws', () => {
  const seeded = seedConfigFromWhatsapp(null);
  assert.ok(seeded && typeof seeded === 'object');
});

test('resolveInstagramConfig seeds when no IG row exists yet', async () => {
  const inserts = [];
  const database = {
    query: async (sql, params) => {
      if (sql.includes('FROM instagram_ai_settings')) return { rows: [] };
      if (sql.includes('FROM bot_configs')) return { rows: [{ config: { storeName: 'WA-Store' } }] };
      if (sql.includes('INSERT INTO instagram_ai_settings')) { inserts.push(params); return { rows: [{}] }; }
      return { rows: [] };
    },
  };
  const cfg = await resolveInstagramConfig('user-1', { database });
  assert.strictEqual(cfg.config.storeName, 'WA-Store');
  assert.strictEqual(cfg.seededFromWhatsapp, true);
  assert.strictEqual(inserts.length, 1, 'should persist the seed once');
});

test('resolveInstagramConfig returns existing IG row without reseeding', async () => {
  const database = {
    query: async (sql) => {
      if (sql.includes('FROM instagram_ai_settings')) {
        return { rows: [{ enabled: true, seeded_from_whatsapp: true, config: { storeName: 'IG-Store' } }] };
      }
      throw new Error('should not read bot_configs when IG row exists');
    },
  };
  const cfg = await resolveInstagramConfig('user-1', { database });
  assert.strictEqual(cfg.config.storeName, 'IG-Store');
  assert.strictEqual(cfg.enabled, true);
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/instagram/instagram-config.test.js` → FAIL.

- [ ] **Step 3: Implement `instagram-config.js`** (reuse `DEFAULT_CONFIG` from `lib/constants.js`).

```javascript
// src/services/instagram/instagram-config.js
const db = require('../../db/client');
const { DEFAULT_CONFIG } = require('../../../lib/constants');

function seedConfigFromWhatsapp(waConfig) {
  // Deep-ish clone so later edits never alias the WhatsApp object.
  const base = { ...DEFAULT_CONFIG, ...(waConfig || {}) };
  return JSON.parse(JSON.stringify(base));
}

async function resolveInstagramConfig(userId, deps = {}) {
  const database = deps.database || db;
  const existing = await database.query(
    'SELECT enabled, seeded_from_whatsapp, config FROM instagram_ai_settings WHERE user_id = $1',
    [userId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      enabled: row.enabled,
      seededFromWhatsapp: row.seeded_from_whatsapp,
      config: { ...DEFAULT_CONFIG, ...(row.config || {}) },
    };
  }
  // First open: seed from WhatsApp config.
  const wa = await database.query('SELECT config FROM bot_configs WHERE user_id = $1', [userId]);
  const seeded = seedConfigFromWhatsapp(wa.rows[0]?.config);
  await database.query(
    `INSERT INTO instagram_ai_settings (user_id, enabled, seeded_from_whatsapp, config)
     VALUES ($1, false, true, $2::jsonb)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, JSON.stringify(seeded)],
  );
  return { enabled: false, seededFromWhatsapp: true, config: seeded };
}

async function saveInstagramConfig(userId, { enabled, config }, deps = {}) {
  const database = deps.database || db;
  await database.query(
    `INSERT INTO instagram_ai_settings (user_id, enabled, seeded_from_whatsapp, config)
     VALUES ($1, $2, true, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = NOW()`,
    [userId, enabled === true, JSON.stringify(config || {})],
  );
}

async function setAiEnabled(userId, enabled, deps = {}) {
  const database = deps.database || db;
  // Ensure a row exists (seed) then flip the flag.
  await resolveInstagramConfig(userId, deps);
  await database.query(
    'UPDATE instagram_ai_settings SET enabled = $2, updated_at = NOW() WHERE user_id = $1',
    [userId, enabled === true],
  );
}

module.exports = { seedConfigFromWhatsapp, resolveInstagramConfig, saveInstagramConfig, setAiEnabled };
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/instagram/instagram-config.js test/instagram/instagram-config.test.js
git commit -m "feat(instagram): config store seeded from WhatsApp on first open"
```

**Risk:** 🟡 Medium (core requirement). **Time:** ~2h.

---

### Task 4: Logs helper

**Files:** Create `src/services/instagram/instagram-logs.js`; Test `test/instagram/instagram-logs.test.js`.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/instagram-logs.test.js
const test = require('node:test');
const assert = require('node:assert');
const { logInstagram } = require('../../src/services/instagram/instagram-logs');

test('logInstagram inserts a row and never throws on db error', async () => {
  let captured = null;
  const okDb = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
  await logInstagram('u1', 'error', 'send', { message: 'boom' }, { database: okDb });
  assert.ok(captured.sql.includes('INSERT INTO instagram_logs'));
  assert.strictEqual(captured.params[0], 'u1');

  const badDb = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(() => logInstagram('u1', 'info', 'x', {}, { database: badDb }));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```javascript
// src/services/instagram/instagram-logs.js
const db = require('../../db/client');

async function logInstagram(userId, level, eventType, detail, deps = {}) {
  const database = deps.database || db;
  try {
    await database.query(
      `INSERT INTO instagram_logs (user_id, level, event_type, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId || null, level || 'info', eventType || null, JSON.stringify(detail || {})],
    );
  } catch (err) {
    // Logging must never break the caller (isolation invariant).
    console.error(`${new Date().toISOString()} [instagram-logs] failed: ${err.message}`);
  }
}

module.exports = { logInstagram };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): fail-safe logs helper`.

**Risk:** 🟢 Low. **Time:** ~30m.

---

# PHASE 3 — Meta connection (OAuth + Graph client + signature)

### Task 5: OAuth pure functions

**Files:** Create `src/services/instagram/instagram-oauth.js`; Test `test/instagram/instagram-oauth.test.js`.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/instagram-oauth.test.js
const test = require('node:test');
const assert = require('node:assert');
const oauth = require('../../src/services/instagram/instagram-oauth');

const env = { INSTAGRAM_APP_ID: 'APPID', INSTAGRAM_APP_SECRET: 'SECRET', INSTAGRAM_REDIRECT_URI: 'https://x/cb', INSTAGRAM_GRAPH_VERSION: 'v25.0' };

test('buildAuthorizeUrl includes scope, redirect, state', () => {
  const url = oauth.buildAuthorizeUrl('state123', { env });
  assert.ok(url.startsWith('https://www.instagram.com/oauth/authorize?'));
  assert.ok(url.includes('client_id=APPID'));
  assert.ok(url.includes('response_type=code'));
  assert.ok(url.includes('instagram_business_basic'));
  assert.ok(url.includes('instagram_business_manage_messages'));
  assert.ok(url.includes('state=state123'));
  assert.ok(url.includes(encodeURIComponent('https://x/cb')));
});

test('exchangeCodeForToken posts form and returns first data entry', async () => {
  const fetchImpl = async (url, opts) => {
    assert.strictEqual(url, 'https://api.instagram.com/oauth/access_token');
    assert.ok(opts.body.includes('grant_type=authorization_code'));
    return { ok: true, json: async () => ({ data: [{ access_token: 'SHORT', user_id: '17841', permissions: 'x' }] }) };
  };
  const r = await oauth.exchangeCodeForToken('CODE', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'SHORT');
  assert.strictEqual(r.userId, '17841');
});

test('exchangeForLongLived returns token + expiry', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://graph.instagram.com/access_token?'));
    assert.ok(url.includes('grant_type=ig_exchange_token'));
    return { ok: true, json: async () => ({ access_token: 'LONG', expires_in: 5183944 }) };
  };
  const r = await oauth.exchangeForLongLived('SHORT', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'LONG');
  assert.ok(r.expiresAt instanceof Date);
});

test('refreshLongLived hits refresh endpoint', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://graph.instagram.com/refresh_access_token?'));
    return { ok: true, json: async () => ({ access_token: 'LONG2', expires_in: 5183944 }) };
  };
  const r = await oauth.refreshLongLived('LONG', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'LONG2');
});

test('exchangeCodeForToken throws on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(() => oauth.exchangeCodeForToken('CODE', { env, fetchImpl }));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (Node 20 has global `fetch`; inject `fetchImpl` for tests; compute `expiresAt` from `expires_in`).

```javascript
// src/services/instagram/instagram-oauth.js
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

function cfg(env) {
  return {
    appId: env.INSTAGRAM_APP_ID,
    appSecret: env.INSTAGRAM_APP_SECRET,
    redirectUri: env.INSTAGRAM_REDIRECT_URI,
    version: env.INSTAGRAM_GRAPH_VERSION || 'v25.0',
  };
}

function buildAuthorizeUrl(state, { env = process.env } = {}) {
  const c = cfg(env);
  const params = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: state || '',
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, { env = process.env, fetchImpl = fetch } = {}) {
  const c = cfg(env);
  const body = new URLSearchParams({
    client_id: c.appId,
    client_secret: c.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: c.redirectUri,
    code,
  }).toString();
  const res = await fetchImpl('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ig_code_exchange_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const entry = Array.isArray(json.data) ? json.data[0] : json;
  return { accessToken: entry.access_token, userId: String(entry.user_id), permissions: entry.permissions };
}

async function exchangeForLongLived(shortToken, { env = process.env, fetchImpl = fetch } = {}) {
  const c = cfg(env);
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: c.appSecret,
    access_token: shortToken,
  });
  const res = await fetchImpl(`https://graph.instagram.com/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_long_lived_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { accessToken: json.access_token, expiresAt: expiryFrom(json.expires_in) };
}

async function refreshLongLived(longToken, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: longToken });
  const res = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_refresh_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { accessToken: json.access_token, expiresAt: expiryFrom(json.expires_in) };
}

function expiryFrom(expiresInSeconds) {
  const ms = (Number(expiresInSeconds) || 0) * 1000;
  return new Date(Date.now() + ms);
}

module.exports = { SCOPES, buildAuthorizeUrl, exchangeCodeForToken, exchangeForLongLived, refreshLongLived };
```

> `Date.now()` is allowed in runtime code (the workflow-script ban does not apply to app source).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): OAuth code/long-lived/refresh helpers`.

**Risk:** 🟡 Medium. **Time:** ~2h.

---

### Task 6: Graph client (send DM, subscribe)

**Files:** Create `src/services/instagram/instagram-graph.js`; Test `test/instagram/instagram-graph.test.js`.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/instagram-graph.test.js
const test = require('node:test');
const assert = require('node:assert');
const graph = require('../../src/services/instagram/instagram-graph');
const env = { INSTAGRAM_GRAPH_VERSION: 'v25.0' };

test('sendDirectMessage posts recipient+text with token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ recipient_id: 'IGSID', message_id: 'mid.1' }) };
  };
  const r = await graph.sendDirectMessage({ token: 'LONG', recipientId: 'IGSID', text: 'hi' }, { env, fetchImpl });
  assert.ok(seen.url.includes('/v25.0/me/messages'));
  const body = JSON.parse(seen.opts.body);
  assert.strictEqual(body.recipient.id, 'IGSID');
  assert.strictEqual(body.message.text, 'hi');
  assert.ok(seen.opts.headers.Authorization.includes('LONG'));
  assert.strictEqual(r.messageId, 'mid.1');
});

test('sendDirectMessage throws on error response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'window_closed' });
  await assert.rejects(() => graph.sendDirectMessage({ token: 'x', recipientId: 'y', text: 'z' }, { env, fetchImpl }),
    /ig_send_failed/);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```javascript
// src/services/instagram/instagram-graph.js
function version(env) { return env.INSTAGRAM_GRAPH_VERSION || 'v25.0'; }

async function sendDirectMessage({ token, recipientId, text }, { env = process.env, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://graph.instagram.com/${version(env)}/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) throw new Error(`ig_send_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { recipientId: json.recipient_id, messageId: json.message_id };
}

async function subscribeToMessages({ token }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ subscribed_fields: 'messages', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/me/subscribed_apps?${params.toString()}`, { method: 'POST' });
  if (!res.ok) throw new Error(`ig_subscribe_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getProfile({ token }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/me?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_profile_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { sendDirectMessage, subscribeToMessages, getProfile };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): graph client send/subscribe/profile`.

**Risk:** 🟡 Medium. **Time:** ~1.5h.

---

### Task 7: Webhook signature verification

**Files:** Create `src/services/instagram/instagram-signature.js`; Test `test/instagram/instagram-signature.test.js`.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/instagram-signature.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyInstagramSignature } = require('../../src/services/instagram/instagram-signature');

const secret = 'APP_SECRET';
const raw = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));
const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

test('accepts a valid signature', () => {
  assert.strictEqual(verifyInstagramSignature(raw, good, secret), true);
});
test('rejects a tampered body', () => {
  assert.strictEqual(verifyInstagramSignature(Buffer.from('{}'), good, secret), false);
});
test('rejects missing header / secret', () => {
  assert.strictEqual(verifyInstagramSignature(raw, '', secret), false);
  assert.strictEqual(verifyInstagramSignature(raw, good, ''), false);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (mirror `verifyMoyasarSignature` in `billing.routes.js`, but with the `sha256=` prefix).

```javascript
// src/services/instagram/instagram-signature.js
const crypto = require('node:crypto');

function verifyInstagramSignature(rawBody, header, appSecret) {
  if (!header || !appSecret || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyInstagramSignature };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): webhook HMAC signature verification`.

**Risk:** 🟢 Low. **Time:** ~30m.

---

# PHASE 2/4 — Queues + ingest

### Task 8: Instagram queues + enqueue helpers

**Files:** Create `src/queues/instagram-queue.js`; Test `test/instagram/instagram-queue.test.js`.

- [ ] **Step 1: Failing test** (verify names + helper shape without a live Redis by injecting a fake queue factory)

```javascript
// test/instagram/instagram-queue.test.js
const test = require('node:test');
const assert = require('node:assert');
const q = require('../../src/services/... ');
```
> (See implementation note: the module exposes `__setQueuesForTest` so we can inject fakes.)

```javascript
// test/instagram/instagram-queue.test.js  (full)
const test = require('node:test');
const assert = require('node:assert');
const iq = require('../../src/queues/instagram-queue');

test('enqueueIncomingInstagram adds job with dedup jobId', async () => {
  const added = [];
  iq.__setQueuesForTest({
    incomingInstagram: { add: async (name, payload, opts) => { added.push({ name, payload, opts }); } },
    outgoingInstagram: { add: async () => {} },
  });
  await iq.enqueueIncomingInstagram({ providerMessageId: 'mid.1', userId: 'u1' });
  assert.strictEqual(added[0].opts.jobId, 'mid.1');
  assert.strictEqual(added[0].name, 'process-incoming-instagram');
});

test('enqueueOutgoingInstagram uses replyMessageId as jobId', async () => {
  const added = [];
  iq.__setQueuesForTest({
    incomingInstagram: { add: async () => {} },
    outgoingInstagram: { add: async (name, payload, opts) => { added.push(opts); } },
  });
  await iq.enqueueOutgoingInstagram({ replyMessageId: 'r1', userId: 'u1', recipientId: 'IGSID', text: 'hi' });
  assert.strictEqual(added[0].jobId, 'r1');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (mirror `src/queues/message-queue.js` lazy `getQueues()`; reuse `getConnection` from `src/queues/redis.js`).

```javascript
// src/queues/instagram-queue.js
const { Queue } = require('bullmq');
const { getConnection } = require('./redis');

const QUEUE_NAMES = Object.freeze({
  incomingInstagram: process.env.INCOMING_INSTAGRAM_QUEUE || 'incoming-instagram',
  outgoingInstagram: process.env.OUTGOING_INSTAGRAM_QUEUE || 'outgoing-instagram',
});

let queues = null;

function createQueue(name) {
  return new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
      backoff: { type: 'exponential', delay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '15000', 10) },
      removeOnComplete: { age: parseInt(process.env.QUEUE_REMOVE_COMPLETE_AGE_SECONDS || '86400', 10) },
      removeOnFail: { age: parseInt(process.env.QUEUE_REMOVE_FAIL_AGE_SECONDS || '604800', 10) },
    },
  });
}

function getQueues() {
  if (!queues) {
    queues = {
      incomingInstagram: createQueue(QUEUE_NAMES.incomingInstagram),
      outgoingInstagram: createQueue(QUEUE_NAMES.outgoingInstagram),
    };
  }
  return queues;
}

function __setQueuesForTest(fake) { queues = fake; }

async function enqueueIncomingInstagram(payload, options = {}) {
  const { incomingInstagram } = getQueues();
  const jobId = options.jobKey || payload.providerMessageId || payload.messageId || undefined;
  return incomingInstagram.add('process-incoming-instagram', payload, { jobId, delay: options.delay || 0 });
}

async function enqueueOutgoingInstagram(payload, options = {}) {
  const { outgoingInstagram } = getQueues();
  const jobId = options.jobKey || payload.replyMessageId || payload.messageId || undefined;
  return outgoingInstagram.add('send-instagram-message', payload, { jobId, delay: options.delay || 0 });
}

module.exports = { QUEUE_NAMES, getQueues, enqueueIncomingInstagram, enqueueOutgoingInstagram, __setQueuesForTest };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): dedicated BullMQ queues + enqueue helpers`.

**Risk:** 🟢 Low. **Time:** ~1h.

---

### Task 9: Ingest (normalize webhook entry → store → enqueue AI)

**Files:** Create `src/services/instagram/instagram-ingest.js`; Test `test/instagram/instagram-ingest.test.js`.

- [ ] **Step 1: Failing test** (pure normalization + guard logic with injected db/enqueue)

```javascript
// test/instagram/instagram-ingest.test.js
const test = require('node:test');
const assert = require('node:assert');
const { extractMessages, ingestWebhookEntry } = require('../../src/services/instagram/instagram-ingest');

test('extractMessages flattens entry[].messaging[] into normalized items', () => {
  const body = { object: 'instagram', entry: [{ id: 'IGACC', messaging: [
    { sender: { id: 'CUST' }, recipient: { id: 'IGACC' }, timestamp: 1, message: { mid: 'm1', text: 'hello' } },
  ] }] };
  const items = extractMessages(body);
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0], { igAccountId: 'IGACC', participantId: 'CUST', mid: 'm1', text: 'hello', echo: false, timestamp: 1 });
});

test('extractMessages skips echoes (our own outbound) and empty', () => {
  const body = { object: 'instagram', entry: [{ id: 'IGACC', messaging: [
    { sender: { id: 'IGACC' }, recipient: { id: 'CUST' }, message: { mid: 'm2', text: 'reply', is_echo: true } },
    { sender: { id: 'CUST' }, recipient: { id: 'IGACC' }, message: { mid: 'm3' } },
  ] }] };
  const items = extractMessages(body).filter((i) => !i.echo && i.text);
  assert.strictEqual(items.length, 0);
});

test('ingestWebhookEntry stores inbound + enqueues AI once (dedup by mid)', async () => {
  const calls = { insertConv: 0, insertMsg: 0, enqueue: 0 };
  const database = { query: async (sql) => {
    if (sql.includes('INSERT INTO instagram_conversations')) { calls.insertConv++; return { rows: [{ id: 'conv1' }] }; }
    if (sql.includes('INSERT INTO instagram_messages')) { calls.insertMsg++; return { rows: [{ id: 'msg1' }] }; }
    return { rows: [] };
  } };
  const enqueueAi = async () => { calls.enqueue++; };
  const item = { igAccountId: 'IGACC', participantId: 'CUST', mid: 'm1', text: 'hello', echo: false, timestamp: 1 };
  await ingestWebhookEntry('u1', item, { database, enqueueAi });
  assert.strictEqual(calls.insertMsg, 1);
  assert.strictEqual(calls.enqueue, 1);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (24h window is recorded on the conversation; `ON CONFLICT DO NOTHING` on `provider_message_id` gives idempotency; if the insert returns no row the message was a duplicate → skip enqueue).

```javascript
// src/services/instagram/instagram-ingest.js
const db = require('../../db/client');
const { enqueueIncomingInstagram } = require('../../queues/instagram-queue');

function extractMessages(body) {
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const igAccountId = entry.id;
    const msgs = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const m of msgs) {
      const message = m.message || {};
      out.push({
        igAccountId,
        participantId: m.sender?.id,
        mid: message.mid,
        text: message.text || '',
        echo: Boolean(message.is_echo),
        timestamp: m.timestamp || null,
      });
    }
  }
  return out;
}

async function ingestWebhookEntry(userId, item, deps = {}) {
  const database = deps.database || db;
  const enqueueAi = deps.enqueueAi || ((payload) => enqueueIncomingInstagram(payload));
  if (!item || item.echo || !item.text || !item.participantId) return { skipped: true };

  const conv = await database.query(
    `INSERT INTO instagram_conversations (user_id, participant_id, last_message_at, window_expires_at, status)
     VALUES ($1, $2, NOW(), NOW() + INTERVAL '24 hours', 'active')
     ON CONFLICT (user_id, participant_id) DO UPDATE
       SET last_message_at = NOW(), window_expires_at = NOW() + INTERVAL '24 hours'
     RETURNING id, ai_paused`,
    [userId, item.participantId],
  );
  const conversationId = conv.rows[0].id;

  const inserted = await database.query(
    `INSERT INTO instagram_messages
       (conversation_id, user_id, participant_id, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1,$2,$3,'inbound','user',$4,$5,'queued_for_ai',$6::jsonb)
     ON CONFLICT (user_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conversationId, userId, item.participantId, item.text, item.mid, JSON.stringify(item)],
  );
  if (!inserted.rows[0]) return { duplicate: true };
  const messageId = inserted.rows[0].id;

  if (conv.rows[0].ai_paused) return { stored: true, aiPaused: true, messageId };

  await enqueueAi({
    userId, conversationId, messageId,
    participantId: item.participantId, text: item.text, providerMessageId: item.mid,
  }, { jobKey: `ig-conversation-${conversationId}` });

  return { stored: true, messageId, conversationId };
}

module.exports = { extractMessages, ingestWebhookEntry };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): webhook ingest + inbound storage + AI enqueue`.

**Risk:** 🟡 Medium. **Time:** ~2.5h.

---

# PHASE 7 — AI reply + send worker (reuses shared brain + quota)

### Task 10: History builder for Instagram

**Files:** Create `src/services/instagram/instagram-history.js`; Test `test/instagram/instagram-history.test.js`.

Mirrors `src/workers/ai-history.js` but reads `instagram_messages`.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/instagram-history.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildInstagramHistory } = require('../../src/services/instagram/instagram-history');

test('returns chronological role/content pairs limited by memoryMessages', async () => {
  const rows = [
    { role: 'assistant', content: 'B', direction: 'outbound', status: 'sent' },
    { role: 'user', content: 'A', direction: 'inbound', status: 'queued_for_ai' },
  ];
  const database = { query: async () => ({ rows }) };
  const hist = await buildInstagramHistory('conv1', 'u1', { memoryMessages: 50 }, { database });
  assert.deepStrictEqual(hist, [
    { role: 'user', content: 'A' },
    { role: 'assistant', content: 'B' },
  ]);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```javascript
// src/services/instagram/instagram-history.js
const db = require('../../db/client');

async function buildInstagramHistory(conversationId, userId, config = {}, deps = {}) {
  const database = deps.database || db;
  const limit = Number(config.memoryMessages) || 50;
  const res = await database.query(
    `SELECT role, content, direction, status FROM instagram_messages
     WHERE conversation_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [conversationId, userId, limit],
  );
  return res.rows
    .filter((r) => r.content)
    .reverse()
    .map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
}

module.exports = { buildInstagramHistory };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(instagram): conversation history builder`.

**Risk:** 🟢 Low. **Time:** ~1h.

---

### Task 11: Instagram worker — AI generation + quota-gated send

**Files:** Create `src/workers/instagram-worker.js`; Test `test/instagram/instagram-worker-logic.test.js`.

Design: one process, two BullMQ workers.
- **Incoming worker** (`incoming-instagram`): load IG config; if `enabled===false` → store nothing further, stop (manual-only mode). Else build history, call `ai-client` (reused), store assistant message `queued_for_send`, enqueue outgoing.
- **Outgoing worker** (`outgoing-instagram`): `checkMessageQuota(userId)` (reused) → if blocked, mark `quota_stop`, stop. Else `sendDirectMessage` via Graph → on success `decrementMessageQuota(userId)` (reused, **shared quota**), mark `sent`, store `message_id`. On send failure (e.g. window closed) mark `window_closed`/`failed` and `logInstagram`.

Extract the two pure decision helpers so they are unit-testable without Redis.

- [ ] **Step 1: Failing test** (test the pure helpers, not BullMQ)

```javascript
// test/instagram/instagram-worker-logic.test.js
const test = require('node:test');
const assert = require('node:assert');
const { shouldGenerateReply, shouldBlockSendForQuota } = require('../../src/workers/instagram-worker');

test('shouldGenerateReply false when AI disabled', () => {
  assert.strictEqual(shouldGenerateReply({ enabled: false }), false);
  assert.strictEqual(shouldGenerateReply({ enabled: true }), true);
});

test('shouldBlockSendForQuota true only when canReply === false', () => {
  assert.strictEqual(shouldBlockSendForQuota({ canReply: false }), true);
  assert.strictEqual(shouldBlockSendForQuota({ canReply: true }), false);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `instagram-worker.js`.** Export the helpers; guard `main()` on the flag; reuse shared modules. (Abbreviated but complete for the logic; the executing agent wires the two `new Worker(...)` instances using the pattern from `outgoing-whatsapp-worker.js:696-740`.)

```javascript
// src/workers/instagram-worker.js
const { Worker } = require('bullmq');
const { getConnection } = require('../queues/redis');
const { QUEUE_NAMES, enqueueOutgoingInstagram } = require('../queues/instagram-queue');
const db = require('../db/client');
const AIClient = require('../../lib/ai-client');
const { resolveInstagramConfig } = require('../services/instagram/instagram-config');
const { buildInstagramHistory } = require('../services/instagram/instagram-history');
const { getAccountToken } = require('../services/instagram/instagram-accounts');
const { sendDirectMessage } = require('../services/instagram/instagram-graph');
const { checkMessageQuota, decrementMessageQuota } = require('../services/billing/message-quota');
const { logInstagram } = require('../services/instagram/instagram-logs');
const { resolveConfigForAI } = require('../services/bot/runtime-bot');

const WORKER_NAME = 'instagram-worker';

function shouldGenerateReply(igSettings) { return igSettings?.enabled === true; }
function shouldBlockSendForQuota(quota) { return quota?.canReply === false; }

async function processIncoming(job) {
  const { userId, conversationId, participantId } = job.data;
  const igSettings = await resolveInstagramConfig(userId);
  if (!shouldGenerateReply(igSettings)) return { skipped: 'ai_disabled' };

  const history = await buildInstagramHistory(conversationId, userId, igSettings.config);
  // Reuse the exact shared AI brain + resolved API keys.
  const apiConfig = await resolveConfigForAI(userId);
  const ai = new AIClient({ ...igSettings.config, ...apiConfig });
  const reply = await ai.getReply(history, { config: igSettings.config });
  if (!reply || !reply.trim()) return { skipped: 'empty_reply' };

  const stored = await db.query(
    `INSERT INTO instagram_messages
       (conversation_id, user_id, participant_id, direction, role, content, status)
     VALUES ($1,$2,$3,'outbound','assistant',$4,'queued_for_send') RETURNING id`,
    [conversationId, userId, participantId, reply],
  );
  await enqueueOutgoingInstagram({
    userId, conversationId, participantId, recipientId: participantId,
    text: reply, replyMessageId: stored.rows[0].id,
  });
  return { generated: true };
}

async function processOutgoing(job) {
  const { userId, recipientId, text, replyMessageId } = job.data;
  const quota = await checkMessageQuota(userId);
  if (shouldBlockSendForQuota(quota)) {
    await db.query(`UPDATE instagram_messages SET status='quota_stop' WHERE id=$1`, [replyMessageId]);
    return { skipped: 'quota_empty' };
  }
  const token = await getAccountToken(userId);
  if (!token) { await logInstagram(userId, 'error', 'send', { reason: 'no_token' }); return { skipped: 'no_token' }; }
  try {
    const result = await sendDirectMessage({ token, recipientId, text });
    await decrementMessageQuota(userId); // SHARED quota — same as WhatsApp
    await db.query(`UPDATE instagram_messages SET status='sent', provider_message_id=$2 WHERE id=$1`,
      [replyMessageId, result.messageId]);
    return { sent: true };
  } catch (err) {
    await db.query(`UPDATE instagram_messages SET status='failed' WHERE id=$1`, [replyMessageId]);
    await logInstagram(userId, 'error', 'send', { message: err.message });
    throw err; // let BullMQ retry per attempts policy
  }
}

function createWorkers() {
  const connection = getConnection();
  const incoming = new Worker(QUEUE_NAMES.incomingInstagram, processIncoming, {
    connection, concurrency: parseInt(process.env.INSTAGRAM_WORKER_CONCURRENCY || '2', 10),
  });
  const outgoing = new Worker(QUEUE_NAMES.outgoingInstagram, processOutgoing, {
    connection, concurrency: 1,
  });
  for (const [w, name] of [[incoming, 'incoming'], [outgoing, 'outgoing']]) {
    w.on('failed', (jobEntry, err) =>
      console.error(`${new Date().toISOString()} [${WORKER_NAME}:${name}] failed ${jobEntry?.id}: ${err?.message}`));
  }
  return { incoming, outgoing };
}

async function main() {
  if (process.env.INSTAGRAM_ENABLED !== 'true') {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] disabled (INSTAGRAM_ENABLED!=true); exiting.`);
    return;
  }
  createWorkers();
  console.log(`${new Date().toISOString()} [${WORKER_NAME}] started`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { shouldGenerateReply, shouldBlockSendForQuota, processIncoming, processOutgoing, createWorkers };
```

> The executing agent MUST confirm the real `AIClient` constructor/`getReply` signature against `lib/ai-client.js` and adapt the two call sites (Task-time verification), keeping behavior identical to how `ai-worker.js` calls it.

- [ ] **Step 4: Run → PASS** (helper tests). Run: `node --test test/instagram/instagram-worker-logic.test.js`.
- [ ] **Step 5: Commit** `feat(instagram): worker (AI generate + quota-gated Graph send)`.

**Risk:** 🟠 High (integrates AI + quota). **Time:** ~4h.

---

# PHASE 4/5/6 — Routes, webhook, dashboard, inbox, manual reply

### Task 12: Instagram routes (OAuth, webhook, status, config, inbox, send)

**Files:**
- Create: `src/routes/instagram.routes.js`, `src/controllers/instagram.controller.js`
- Modify: `src/routes/index.js` (mount), `src/server.js` (RAW_BODY_PATHS + mount)
- Test: `test/instagram/instagram-routes.test.js` (supertest-style against the router with fakes)

Endpoints (all under a self-guard: if `INSTAGRAM_ENABLED!=='true'`, the API routes return `503 {error:'instagram_disabled'}`, except the webhook which still must 200 the handshake):

| Method + Path | Auth | Purpose |
|---|---|---|
| `GET /api/instagram/connect` | user | Redirect to `buildAuthorizeUrl(state)`; `state` = signed userId in session. |
| `GET /instagram/auth/callback` | user | Exchange `code` → short → long; `getProfile`; `upsertAccount`; `subscribeToMessages`; redirect to dashboard `#instagram`. |
| `GET /instagram/webhook` | none | Handshake: echo `hub.challenge` if `hub.verify_token` matches. |
| `POST /instagram/webhook` | none (HMAC) | Raw body; `verifyInstagramSignature`; `extractMessages`; map `igAccountId`→userId via `instagram_accounts`; `ingestWebhookEntry`; **return 200 immediately**. |
| `GET /api/instagram/status` | user | `{ connected, username, tokenExpiresAt, aiEnabled }`. |
| `POST /api/instagram/disconnect` | user | `disconnectAccount`. |
| `GET /api/instagram/config` | user | `resolveInstagramConfig` (seeds on first call). |
| `POST /api/instagram/config` | user | `saveInstagramConfig`. |
| `POST /api/instagram/ai-toggle` | user | `setAiEnabled`. |
| `GET /api/instagram/conversations` | user | list from `instagram_conversations`. |
| `GET /api/instagram/conversations/:id/messages` | user | messages for a conversation (ownership-checked by `user_id`). |
| `POST /api/instagram/conversations/:id/send` | user | manual reply: store `sent_by_human`, enqueue outgoing (still quota-decremented on send). |

- [ ] **Step 1: Failing test** (webhook handshake + signature rejection + ingest path, with injected deps)

```javascript
// test/instagram/instagram-routes.test.js
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('node:crypto');
const request = require('supertest'); // add as devDependency if absent
const { createInstagramRoutes } = require('../../src/routes/instagram.routes');

function appWith(env, deps) {
  const app = express();
  // mimic server.js raw-body handling for the webhook path
  app.use('/instagram/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(createInstagramRoutes({ env, ...deps }));
  return app;
}

test('GET webhook echoes challenge when verify token matches', async () => {
  const app = appWith({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'VT' }, {});
  const res = await request(app).get('/instagram/webhook')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'VT', 'hub.challenge': '12345' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, '12345');
});

test('GET webhook 403 on wrong verify token', async () => {
  const app = appWith({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'VT' }, {});
  const res = await request(app).get('/instagram/webhook').query({ 'hub.verify_token': 'WRONG', 'hub.challenge': 'x' });
  assert.strictEqual(res.status, 403);
});

test('POST webhook rejects bad signature with 401 and does not ingest', async () => {
  let ingested = 0;
  const app = appWith(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: 'S' },
    { ingest: { extractMessages: () => [{}], ingestWebhookEntry: async () => { ingested++; } },
      accounts: { findUserIdByIgAccount: async () => 'u1' } },
  );
  const res = await request(app).post('/instagram/webhook')
    .set('X-Hub-Signature-256', 'sha256=deadbeef').set('Content-Type', 'application/json').send({ object: 'instagram' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(ingested, 0);
});

test('POST webhook 200 + ingests on good signature', async () => {
  let ingested = 0;
  const secret = 'S';
  const payload = { object: 'instagram', entry: [{ id: 'IGACC', messaging: [{ sender: { id: 'C' }, message: { mid: 'm1', text: 'hi' } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const app = appWith(
    { INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_SECRET: secret },
    { ingest: {
        extractMessages: (b) => [{ igAccountId: 'IGACC', participantId: 'C', mid: 'm1', text: 'hi', echo: false }],
        ingestWebhookEntry: async () => { ingested++; },
      },
      accounts: { findUserIdByIgAccount: async () => 'u1' } },
  );
  const res = await request(app).post('/instagram/webhook')
    .set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(raw);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ingested, 1);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `instagram.routes.js`** (dependency-injectable so the tests above pass; defaults wire real services). Include the flag self-guard, the raw-body webhook, and the API endpoints. Add `findUserIdByIgAccount(igAccountId)` to `instagram-accounts.js` (`SELECT user_id FROM instagram_accounts WHERE ig_user_id=$1`).

```javascript
// src/routes/instagram.routes.js  (core; full endpoint bodies delegate to the controller)
const express = require('express');
const { verifyInstagramSignature } = require('../services/instagram/instagram-signature');
const defaultOauth = require('../services/instagram/instagram-oauth');
const defaultAccounts = require('../services/instagram/instagram-accounts');
const defaultIngest = require('../services/instagram/instagram-ingest');
const defaultGraph = require('../services/instagram/instagram-graph');
const defaultConfig = require('../services/instagram/instagram-config');

function createInstagramRoutes(deps = {}) {
  const env = deps.env || process.env;
  const oauth = deps.oauth || defaultOauth;
  const accounts = deps.accounts || defaultAccounts;
  const ingest = deps.ingest || defaultIngest;
  const graph = deps.graph || defaultGraph;
  const cfg = deps.config || defaultConfig;
  const requireAuth = deps.requireAuth || ((req, res, next) => (req.session?.userId ? next() : res.status(401).json({ error: 'auth' })));
  const router = express.Router();

  const enabled = () => env.INSTAGRAM_ENABLED === 'true';
  const guard = (req, res, next) => (enabled() ? next() : res.status(503).json({ error: 'instagram_disabled' }));

  // --- Webhook handshake (must work even to prove endpoint; still checks verify token) ---
  router.get('/instagram/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    return res.sendStatus(403);
  });

  // --- Webhook receive (raw body already applied by server.js RAW_BODY_PATHS) ---
  router.post('/instagram/webhook', async (req, res) => {
    try {
      const sig = req.headers['x-hub-signature-256'];
      if (!verifyInstagramSignature(req.body, sig, env.INSTAGRAM_APP_SECRET)) return res.sendStatus(401);
      // Acknowledge fast; process async so a slow DB never times out Meta.
      res.sendStatus(200);
      if (!enabled()) return;
      const body = JSON.parse(req.body.toString('utf8'));
      const items = ingest.extractMessages(body);
      for (const item of items) {
        const userId = await accounts.findUserIdByIgAccount(item.igAccountId);
        if (userId) await ingest.ingestWebhookEntry(userId, item);
      }
    } catch (err) {
      // already 200'd; log only
      console.error(`${new Date().toISOString()} [instagram-webhook] ${err.message}`);
    }
  });

  // --- OAuth connect / callback ---
  router.get('/api/instagram/connect', guard, requireAuth, (req, res) => {
    const state = req.session.userId; // simple; server may sign it
    res.redirect(oauth.buildAuthorizeUrl(state, { env }));
  });

  router.get('/instagram/auth/callback', guard, requireAuth, async (req, res, next) => {
    try {
      const short = await oauth.exchangeCodeForToken(req.query.code, { env });
      const long = await oauth.exchangeForLongLived(short.accessToken, { env });
      const profile = await graph.getProfile({ token: long.accessToken }, { env });
      await accounts.upsertAccount(req.session.userId, {
        igUserId: profile.user_id || short.userId, igUsername: profile.username,
        token: long.accessToken, expiresAt: long.expiresAt,
      });
      await graph.subscribeToMessages({ token: long.accessToken }, { env });
      res.redirect('/#instagram');
    } catch (err) { next(err); }
  });

  // --- Status / disconnect / config / toggle / inbox / manual send ---
  // (delegated to instagram.controller.js; see Task 12 controller)
  deps.mountApi?.(router, { guard, requireAuth, accounts, cfg });

  return router;
}

module.exports = { createInstagramRoutes };
```

Then in `src/routes/index.js` add:

```javascript
const { createInstagramRoutes } = require('./instagram.routes');
// inside mountRoutes(app, deps):
app.use(createInstagramRoutes(deps));
```

Then in `src/server.js`:

```javascript
// add the webhook to the raw-body set (near line 232)
const RAW_BODY_PATHS = new Set([
  '/billing/moyasar/webhook',
  '/instagram/webhook',
]);
```

- [ ] **Step 4: Run → PASS.** Run: `node --test test/instagram/instagram-routes.test.js`.
- [ ] **Step 5: Commit** `feat(instagram): routes (oauth, webhook, config, inbox, manual send)`.

**Risk:** 🟠 High (external surface). **Time:** ~5h.

---

### Task 13: Dashboard Instagram tab (connection + seeded settings + inbox)

**Files:**
- Modify: `dashboard/index.html` (add nav button + `#view-instagram` + `<script src="/dashboard/instagram.js">`)
- Create: `dashboard/instagram.js`
- Test: `test/instagram/dashboard-instagram.test.js` (DOM-string presence checks; no browser)

The settings sub-panel is a **structural clone** of the WhatsApp settings tab (`dashboard/index.html:977-2090`) with input IDs prefixed `ig_` and its own load/save hitting `/api/instagram/config`. Because `/api/instagram/config` seeds from WhatsApp on first call, the form opens pre-filled (requirement #3). The `fillForm`/`saveConf` logic is copied to `igFillForm`/`igSaveConf` in `dashboard/instagram.js`, pointing at the `ig_`-prefixed IDs.

- [ ] **Step 1: Failing test**

```javascript
// test/instagram/dashboard-instagram.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'instagram.js'), 'utf8');

test('index.html has an Instagram tab + view container + script', () => {
  assert.ok(/goTab\(['"]instagram['"]\)/.test(html), 'nav button missing');
  assert.ok(html.includes('id="view-instagram"'), 'view container missing');
  assert.ok(html.includes('/dashboard/instagram.js'), 'script include missing');
});

test('instagram.js loads and saves via the isolated endpoints', () => {
  assert.ok(js.includes("/api/instagram/config"));
  assert.ok(js.includes("/api/instagram/status"));
  assert.ok(js.includes("/api/instagram/connect"));
  assert.ok(js.includes('igFillForm'));
  assert.ok(js.includes('igSaveConf'));
});

test('instagram.js never calls the WhatsApp /api/config endpoint', () => {
  assert.ok(!/['"]\/api\/config['"]/.test(js), 'must not touch WhatsApp config');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3a: Add to `dashboard/index.html`** — a nav button next to the existing tabs, e.g.:

```html
<button class="tab" onclick="goTab('instagram')">إنستقرام</button>
```

and a view container before the closing of the main content area:

```html
<div class="view" id="view-instagram">
  <div class="sw">
    <div class="panel">
      <div class="phdr">ربط إنستقرام</div>
      <div class="pbdy" id="igConnPanel">
        <div id="igStatus">…</div>
        <a class="btn" href="/api/instagram/connect" id="igConnectBtn">ربط حساب إنستقرام</a>
        <button class="btn danger" id="igDisconnectBtn" onclick="igDisconnect()">فصل</button>
      </div>
    </div>
    <div class="panel">
      <div class="phdr">إعدادات ذكاء إنستقرام (منسوخة من الواتساب — عدّل فقط)</div>
      <div class="pbdy" id="igSettingsPanel">
        <!-- Clone of the WhatsApp settings inputs with ids prefixed ig_ .
             Copy the markup blocks from index.html:1022-1332 and rename ids. -->
        <label>تفعيل الرد الآلي <input type="checkbox" id="ig_enabled"></label>
        <textarea id="ig_botInstr"></textarea>
        <input id="ig_storeName"><input id="ig_rsEmployeeName">
        <select id="ig_rsEmoji"><option value="none">بدون</option><option value="light">خفيف</option><option value="medium">متوسط</option><option value="heavy">كثير</option></select>
        <input id="ig_maxLen" type="number">
        <button class="btn" onclick="igSaveConf()">حفظ إعدادات إنستقرام</button>
      </div>
    </div>
    <div class="panel">
      <div class="phdr">الرسائل (Inbox)</div>
      <div class="pbdy"><div id="igConvList"></div><div id="igThread"></div></div>
    </div>
  </div>
</div>
```

> The executing agent should copy the FULL WhatsApp settings input set (from `index.html:1022-1332`) and rename each `id` to its `ig_` equivalent, so the Instagram settings page is a true field-for-field clone. The abbreviated set above is the minimum for tests to pass; expand to full parity.

- [ ] **Step 3b: Create `dashboard/instagram.js`** — clone `loadConf`/`fillForm`/`saveConf`/`loadQuota` as `igLoadConf`/`igFillForm`/`igSaveConf`, pointing at `/api/instagram/*`, reading `ig_`-prefixed inputs, plus `igLoadStatus`, `igDisconnect`, `igLoadInbox`. Register an `onTab` hook so `goTab('instagram')` calls `igLoadStatus()` + `igLoadConf()` + `igLoadInbox()`.

```javascript
// dashboard/instagram.js  (structure; expand field mapping to full parity)
let igConfig = {};
async function igLoadStatus() {
  const r = await fetch('/api/instagram/status'); if (!r.ok) return;
  const d = await r.json();
  document.getElementById('igStatus').textContent = d.connected
    ? `مربوط: @${d.username || ''}` : 'غير مربوط';
  document.getElementById('igConnectBtn').style.display = d.connected ? 'none' : '';
  document.getElementById('igDisconnectBtn').style.display = d.connected ? '' : 'none';
}
async function igLoadConf() {
  const r = await fetch('/api/instagram/config'); if (!r.ok) return;
  const d = await r.json(); igConfig = d.config || {};
  igFillForm(igConfig, d.enabled);
}
function igFillForm(c, enabled) {
  document.getElementById('ig_enabled').checked = enabled === true;
  document.getElementById('ig_botInstr').value = c.botInstructions || '';
  document.getElementById('ig_storeName').value = c.storeName || '';
  document.getElementById('ig_rsEmployeeName').value = (c.replyStyle || {}).employeeName || '';
  document.getElementById('ig_rsEmoji').value = (c.replyStyle || {}).emojiLevel || 'none';
  document.getElementById('ig_maxLen').value = c.maxResponseLength || 300;
  // …expand to every field cloned from the WhatsApp form
}
async function igSaveConf() {
  const nc = { ...igConfig,
    botInstructions: document.getElementById('ig_botInstr').value.trim(),
    storeName: document.getElementById('ig_storeName').value.trim(),
    maxResponseLength: parseInt(document.getElementById('ig_maxLen').value) || 300,
    replyStyle: { ...(igConfig.replyStyle || {}),
      employeeName: document.getElementById('ig_rsEmployeeName').value.trim(),
      emojiLevel: document.getElementById('ig_rsEmoji').value },
  };
  const enabled = document.getElementById('ig_enabled').checked;
  const r = await fetch('/api/instagram/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, config: nc }) });
  const d = await r.json();
  if (d.success) { igConfig = nc; toast('✅ تم حفظ إعدادات إنستقرام'); } else toast('❌ تعذر الحفظ', true);
}
async function igDisconnect() {
  await fetch('/api/instagram/disconnect', { method: 'POST' }); igLoadStatus();
}
async function igLoadInbox() {
  const r = await fetch('/api/instagram/conversations'); if (!r.ok) return;
  const d = await r.json();
  document.getElementById('igConvList').innerHTML =
    (d.conversations || []).map((c) => `<div class="conv" onclick="igOpen('${c.id}')">@${c.participant_username || c.participant_id}</div>`).join('');
}
async function igOpen(id) {
  const r = await fetch(`/api/instagram/conversations/${id}/messages`); const d = await r.json();
  document.getElementById('igThread').innerHTML =
    (d.messages || []).map((m) => `<div class="msg ${m.direction}">${m.content}</div>`).join('') +
    `<div><input id="igReply"><button onclick="igSend('${id}')">إرسال</button></div>`;
}
async function igSend(id) {
  const text = document.getElementById('igReply').value.trim(); if (!text) return;
  await fetch(`/api/instagram/conversations/${id}/send`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  igOpen(id);
}
window.igOnTab = () => { igLoadStatus(); igLoadConf(); igLoadInbox(); };
```

Add one line in the existing `goTab()` in `index.html`: `if (name==='instagram' && window.igOnTab) window.igOnTab();`

- [ ] **Step 4: Run → PASS.** Run: `node --test test/instagram/dashboard-instagram.test.js`.
- [ ] **Step 5: Commit** `feat(instagram): dashboard tab — connect, seeded settings, inbox, manual reply`.

**Risk:** 🟡 Medium. **Time:** ~5h (full field parity).

---

### Task 14: Start-all process entry + token refresh timer

**Files:**
- Modify: `src/runtime/start-all.js`, `src/server.js`
- Create: `src/services/instagram/token-refresh.js`; Test `test/instagram/token-refresh.test.js`

- [ ] **Step 1: Failing test** (refresh sweep logic with fakes)

```javascript
// test/instagram/token-refresh.test.js
const test = require('node:test');
const assert = require('node:assert');
const { refreshDueTokens } = require('../../src/services/instagram/token-refresh');

test('refreshes accounts and stores the new token', async () => {
  const saved = [];
  const deps = {
    accounts: {
      listConnectedAccounts: async () => [{ user_id: 'u1' }],
      getAccountToken: async () => 'OLD',
      upsertAccount: async (uid, o) => saved.push({ uid, o }),
      getAccount: async () => ({ ig_user_id: '17', ig_username: 'x' }),
    },
    oauth: { refreshLongLived: async () => ({ accessToken: 'NEW', expiresAt: new Date() }) },
    logInstagram: async () => {},
  };
  await refreshDueTokens(deps);
  assert.strictEqual(saved[0].o.token, 'NEW');
});

test('one account failing does not stop the others', async () => {
  let saved = 0;
  const deps = {
    accounts: {
      listConnectedAccounts: async () => [{ user_id: 'bad' }, { user_id: 'good' }],
      getAccountToken: async (uid) => (uid === 'bad' ? (() => { throw new Error('x'); })() : 'OLD'),
      getAccount: async () => ({ ig_user_id: '17' }),
      upsertAccount: async () => { saved++; },
    },
    oauth: { refreshLongLived: async () => ({ accessToken: 'NEW', expiresAt: new Date() }) },
    logInstagram: async () => {},
  };
  await refreshDueTokens(deps);
  assert.strictEqual(saved, 1);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3a: Implement `token-refresh.js`**

```javascript
// src/services/instagram/token-refresh.js
const defaultAccounts = require('./instagram-accounts');
const defaultOauth = require('./instagram-oauth');
const { logInstagram: defaultLog } = require('./instagram-logs');

async function refreshDueTokens(deps = {}) {
  const accounts = deps.accounts || defaultAccounts;
  const oauth = deps.oauth || defaultOauth;
  const logInstagram = deps.logInstagram || defaultLog;
  const rows = await accounts.listConnectedAccounts();
  for (const row of rows) {
    try {
      const token = await accounts.getAccountToken(row.user_id);
      if (!token) continue;
      const refreshed = await oauth.refreshLongLived(token);
      const acc = await accounts.getAccount(row.user_id);
      await accounts.upsertAccount(row.user_id, {
        igUserId: acc?.ig_user_id, igUsername: acc?.ig_username,
        token: refreshed.accessToken, expiresAt: refreshed.expiresAt,
      });
    } catch (err) {
      await logInstagram(row.user_id, 'error', 'token_refresh', { message: err.message });
    }
  }
}

function startTokenRefreshTimer() {
  const ms = parseInt(process.env.INSTAGRAM_TOKEN_REFRESH_INTERVAL_MS || '86400000', 10);
  const timer = setInterval(() => { refreshDueTokens().catch(() => {}); }, ms);
  timer.unref?.();
  return timer;
}

module.exports = { refreshDueTokens, startTokenRefreshTimer };
```

- [ ] **Step 3b: Wire `start-all.js`** — add a guarded process entry:

```javascript
const processes = [
  { name: 'web', command: 'node', args: ['src/server.js'], required: true },
  { name: 'ai-worker', command: 'node', args: ['src/workers/ai-worker.js'], required: false, restartable: true },
];
if (process.env.INSTAGRAM_ENABLED === 'true') {
  processes.push({ name: 'instagram-worker', command: 'node', args: ['src/workers/instagram-worker.js'], required: false, restartable: true });
}
```

- [ ] **Step 3c: Wire `server.js`** — start the refresh timer only when enabled (near the outgoing-worker/health-monitor startup block, ~line 962):

```javascript
if (process.env.INSTAGRAM_ENABLED === 'true') {
  try {
    require('./services/instagram/token-refresh').startTokenRefreshTimer();
    console.log(`${new Date().toISOString()} [server] instagram token refresh timer started`);
  } catch (err) {
    console.error(`${new Date().toISOString()} [server] instagram refresh timer failed: ${err.message}`);
  }
}
```

- [ ] **Step 4: Run → PASS.** Run: `node --test test/instagram/token-refresh.test.js`.
- [ ] **Step 5: Commit** `feat(instagram): worker process entry + daily token refresh (flag-gated)`.

**Risk:** 🟡 Medium. **Time:** ~2h.

---

# PHASE 8 — Full test pass + isolation proof

### Task 15: Isolation + full-suite verification

**Files:** Create `test/instagram/isolation.test.js`.

- [ ] **Step 1: Write the isolation test**

```javascript
// test/instagram/isolation.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8'); }

test('instagram code never imports baileys', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'services', 'instagram');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/baileys/i.test(src), `${f} must not import baileys`);
  }
});

test('whatsapp worker files were not modified to depend on instagram', () => {
  assert.ok(!read('src/workers/ai-worker.js').includes('instagram'));
  assert.ok(!read('src/workers/outgoing-whatsapp-worker.js').includes('instagram'));
});

test('instagram uses the SHARED quota functions (proves shared billing)', () => {
  const worker = read('src/workers/instagram-worker.js');
  assert.ok(worker.includes('decrementMessageQuota'));
  assert.ok(worker.includes('checkMessageQuota'));
});

test('everything is gated behind INSTAGRAM_ENABLED', () => {
  assert.ok(read('src/workers/instagram-worker.js').includes("INSTAGRAM_ENABLED"));
  assert.ok(read('src/routes/instagram.routes.js').includes("INSTAGRAM_ENABLED"));
});
```

- [ ] **Step 2: Run → should PASS** if all prior tasks were done correctly. Fix any failures in the offending task's files (do not weaken the test).

- [ ] **Step 3: Run the entire suite**

Run: `npm test` (and `node --test test/instagram/`)
Expected: existing WhatsApp tests unchanged & green; all `test/instagram/*` green.

- [ ] **Step 4: Manual dev-mode smoke checklist** (documented, done by the owner in Meta dev mode on his own account):
  - Set env: `INSTAGRAM_ENABLED=true`, App ID/Secret/redirect/verify-token, deploy.
  - Dashboard → إنستقرام → ربط → complete OAuth → status shows `مربوط: @handle`.
  - In Meta App dashboard, set webhook callback `https://<app>/instagram/webhook` + verify token → handshake passes.
  - Send a DM from a second IG account → appears in Inbox; if AI enabled, an auto-reply is sent; quota decremented by 1.
  - Toggle AI off → only manual replies send.
  - Disconnect → status returns to غير مربوط.

- [ ] **Step 5: Commit** `test(instagram): isolation guarantees + full-suite green`.

**Risk:** 🟠 High (integration truth). **Time:** ~3h + owner smoke test.

---

# PHASE 9 — Production readiness (owner/ops, not code)

- [ ] Keep `INSTAGRAM_ENABLED=false` in production until App Review is granted; dogfood on the owner's own account in dev mode.
- [ ] Before selling to customers' own accounts: Business Verification + App Review for `instagram_business_basic` + `instagram_business_manage_messages` (Advanced Access). Prepare privacy policy URL, screencast, use-case description.
- [ ] Confirm Human-Agent-tag JSON casing against the live Send API reference if/when extending replies beyond the 24h window (deferred feature).
- [ ] Confirm the exact `AIClient` constructor/`getReply` signature used by `ai-worker.js` and keep Instagram's two call sites identical.

---

## Self-Review

**1. Spec coverage:**
- Isolation (req #1): Tasks 1,8,9,11,12,14 create separate tables/queues/worker/routes; Task 15 proves no Baileys import, no WhatsApp-file changes, flag-gating. ✅
- Shared quota (req #2): Task 11 calls `checkMessageQuota`/`decrementMessageQuota`; Task 15 asserts their presence. ✅
- Seeded settings (req #3): Task 3 `resolveInstagramConfig` seeds from `bot_configs`; Task 13 opens the form pre-filled via `/api/instagram/config`. ✅
- MVP scope (connect one account, receive DM, store, inbox, manual reply, AI on/off, simple AI reply, escalation-not-in-MVP, error logs): Tasks 2,5,6,7,9,11,12,13 + Task 4 logs. ✅ (Human escalation reuse deferred; noted.)
- Dashboard pages (Connection/Inbox/AI Settings/Templates/Logs/Status): Connection, Inbox, AI Settings, Status covered in Task 13; Templates reuse `autoReplyKeywords` from the cloned form; Logs surfaced via `instagram_logs` (a read endpoint can be added trivially). ✅
- DB tables (accounts/conversations/messages/ai_settings/logs): Task 1. ✅
- Reply system (understand→reply, AI-vs-human, dedup, quota, context, length): reuses shared `ai-client` behavior in Task 11; history in Task 10. ✅
- Risks & mitigations: token refresh (Task 14), webhook signature (Task 7), duplicate replies (dedup via unique `provider_message_id` in Task 9; shared AI dedup), 24h window (`window_expires_at` recorded; send failure handled in Task 11), IG/WA mixing (Task 15), scaling/multi-tenant (per-`user_id` isolation throughout). ✅

**2. Placeholder scan:** No `TODO`/`TBD`. Two explicit implementation-time verifications are flagged (AIClient signature; Human-Agent JSON) — these are verification notes, not missing code, because they depend on the live external API/existing module and must be confirmed against source at build time.

**3. Type consistency:** Function names consistent across tasks: `resolveInstagramConfig`, `saveInstagramConfig`, `setAiEnabled`, `encodeToken`/`decodeToken`, `upsertAccount`/`getAccountToken`/`findUserIdByIgAccount`/`listConnectedAccounts`, `buildAuthorizeUrl`/`exchangeCodeForToken`/`exchangeForLongLived`/`refreshLongLived`, `sendDirectMessage`/`subscribeToMessages`/`getProfile`, `verifyInstagramSignature`, `extractMessages`/`ingestWebhookEntry`, `enqueueIncomingInstagram`/`enqueueOutgoingInstagram`, `shouldGenerateReply`/`shouldBlockSendForQuota`, `refreshDueTokens`/`startTokenRefreshTimer`. Queue names `incoming-instagram`/`outgoing-instagram` consistent. `instagram_*` table/column names consistent between Task 1 and their consumers.

---

## Execution Handoff

Estimated total: **~38 engineering hours (~1.5–2 focused weeks)**, plus Meta App Review lead time before selling. All code lands behind `INSTAGRAM_ENABLED=false`, so it is safe to merge and deploy incrementally without touching WhatsApp.
