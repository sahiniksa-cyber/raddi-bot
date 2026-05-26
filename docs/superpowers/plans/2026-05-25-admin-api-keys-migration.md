# Admin API Keys Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API key management from per-customer dashboard input into an admin-controlled global pool with optional per-customer override (admin-managed), so customers never see or enter API keys.

**Architecture:** Add a new `admin_api_keys` table (provider → key, singleton-per-provider). When loading a bot config for AI execution, the existing per-customer key in `bot_configs.config` wins as override; otherwise the admin global key is used. Customer dashboard inputs are removed entirely; admin dashboard gains a key management section. The AIClient code (`lib/ai-client.js`) stays untouched — we merge keys *before* the client sees the config, so resolution logic is unchanged. This keeps the blast radius small and lets every existing AI test continue passing without modification.

**Tech Stack:** Node.js + Express + PostgreSQL (pg) + node:test + node:assert/strict + Vanilla JS dashboard.

---

## Pre-flight checks

- [ ] **Confirm baseline is green**

```bash
npm test
```
Expected: `ℹ pass 202` (or higher), `ℹ fail 0`.
**Stop and report if any test fails.** Do not start the plan until baseline is green.

- [ ] **Confirm worktree branch**

```bash
git status && git branch --show-current
```
Expected: clean working tree, branch `claude/crazy-greider-e7e237`.

---

## Task 1: Database migration — `admin_api_keys` table

**Files:**
- Modify: `src/db/migrations/init.js` (append a new CREATE TABLE statement to the `statements` array)
- Test: `tests/admin-api-keys-schema.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/admin-api-keys-schema.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('init.js declares admin_api_keys table with provider PK and api_key column', () => {
  const initSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
    'utf8'
  );
  assert.match(initSrc, /CREATE TABLE IF NOT EXISTS admin_api_keys/i);
  assert.match(initSrc, /provider\s+TEXT\s+PRIMARY KEY/i);
  assert.match(initSrc, /api_key\s+TEXT\s+NOT NULL/i);
  assert.match(initSrc, /updated_at\s+TIMESTAMPTZ/i);
  assert.match(initSrc, /updated_by\s+UUID/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --test tests/admin-api-keys-schema.test.js
```
Expected: FAIL — the table declaration is missing.

- [ ] **Step 3: Add the migration statement**

In `src/db/migrations/init.js`, after the last `whatsapp_sessions` ALTER statement (around the `connection_lease_expires_at` block, before the `conversations` CREATE TABLE), add:

```javascript
  `CREATE TABLE IF NOT EXISTS admin_api_keys (
    provider TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test tests/admin-api-keys-schema.test.js
```
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regression**

```bash
npm test
```
Expected: `pass 203`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/init.js tests/admin-api-keys-schema.test.js
git commit -m "feat(db): add admin_api_keys table for global key vault"
```

---

## Task 2: Repository — `admin-api-keys` service (read + write + mask)

**Files:**
- Create: `src/services/admin/admin-api-keys.js`
- Create: `tests/admin-api-keys-service.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/admin-api-keys-service.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskApiKey, normalizeProvider, ALLOWED_PROVIDERS } = require('../src/services/admin/admin-api-keys');

test('ALLOWED_PROVIDERS contains the four supported providers', () => {
  assert.deepEqual([...ALLOWED_PROVIDERS].sort(), ['anthropic', 'google', 'openai', 'openrouter']);
});

test('normalizeProvider lowercases and validates against allowlist', () => {
  assert.equal(normalizeProvider('OpenAI'), 'openai');
  assert.equal(normalizeProvider(' google '), 'google');
  assert.throws(() => normalizeProvider('foobar'), /provider/i);
  assert.throws(() => normalizeProvider(''), /provider/i);
});

test('maskApiKey returns null for empty input', () => {
  assert.equal(maskApiKey(''), null);
  assert.equal(maskApiKey(null), null);
  assert.equal(maskApiKey(undefined), null);
});

test('maskApiKey shows only last 4 characters for short keys', () => {
  assert.equal(maskApiKey('sk-12345678'), '••••5678');
});

test('maskApiKey preserves the provider prefix and last 4 characters for long keys', () => {
  assert.equal(maskApiKey('sk-proj-abcdefghijklmnop'), 'sk-proj-••••mnop');
  assert.equal(maskApiKey('AIzaSyAbCdEfGhIjKlMnOpQr'), 'AIza••••OpQr');
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
node --test tests/admin-api-keys-service.test.js
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/services/admin/admin-api-keys.js`**

```javascript
'use strict';

const db = require('../../db/client');

const ALLOWED_PROVIDERS = new Set(['openai', 'google', 'anthropic', 'openrouter']);

function normalizeProvider(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(value)) {
    throw new Error(`provider غير مدعوم: ${raw}`);
  }
  return value;
}

function maskApiKey(key) {
  const value = String(key || '').trim();
  if (!value) return null;
  if (value.length <= 8) return `••••${value.slice(-4)}`;
  const prefixMatch = value.match(/^([A-Za-z]+(?:-[A-Za-z]+)?(?:-)?)/);
  const prefix = prefixMatch ? prefixMatch[1] : value.slice(0, 4);
  return `${prefix}••••${value.slice(-4)}`;
}

async function getAllAdminApiKeys() {
  const { rows } = await db.query(
    'SELECT provider, api_key FROM admin_api_keys'
  );
  const out = { openai: '', google: '', anthropic: '', openrouter: '' };
  for (const row of rows) {
    out[row.provider] = row.api_key || '';
  }
  return out;
}

async function getAdminApiKeysMasked() {
  const all = await getAllAdminApiKeys();
  return {
    openai: maskApiKey(all.openai),
    google: maskApiKey(all.google),
    anthropic: maskApiKey(all.anthropic),
    openrouter: maskApiKey(all.openrouter),
  };
}

async function setAdminApiKey(provider, apiKey, adminUserId) {
  const p = normalizeProvider(provider);
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) {
    await db.query('DELETE FROM admin_api_keys WHERE provider = $1', [p]);
    return { provider: p, cleared: true };
  }
  await db.query(
    `INSERT INTO admin_api_keys (provider, api_key, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (provider) DO UPDATE
       SET api_key = EXCLUDED.api_key,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [p, trimmed, adminUserId || null]
  );
  return { provider: p, cleared: false };
}

module.exports = {
  ALLOWED_PROVIDERS,
  normalizeProvider,
  maskApiKey,
  getAllAdminApiKeys,
  getAdminApiKeysMasked,
  setAdminApiKey,
};
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
node --test tests/admin-api-keys-service.test.js
```
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

```bash
npm test
```
Expected: `pass 208`, `fail 0` (5 new tests added).

- [ ] **Step 6: Commit**

```bash
git add src/services/admin/admin-api-keys.js tests/admin-api-keys-service.test.js
git commit -m "feat(admin): add admin-api-keys service with masking helper"
```

---

## Task 3: Resolver — merge admin + customer keys before AIClient

**Files:**
- Create: `src/services/config/api-keys-resolver.js`
- Create: `tests/api-keys-resolver.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/api-keys-resolver.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeApiKeys } = require('../src/services/config/api-keys-resolver');

test('mergeApiKeys uses admin keys when customer has none', () => {
  const merged = mergeApiKeys(
    { model: 'google/gemini-2.0-flash' },
    { openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.googleApiKey, 'admin-google');
  assert.equal(merged.openaiApiKey, 'admin-openai');
  assert.equal(merged.anthropicApiKey, '');
  assert.equal(merged.openrouterApiKey, '');
  assert.equal(merged.model, 'google/gemini-2.0-flash', 'preserves other config fields');
});

test('mergeApiKeys lets a non-empty customer key override the admin key', () => {
  const merged = mergeApiKeys(
    { openaiApiKey: 'customer-openai' },
    { openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.openaiApiKey, 'customer-openai');
  assert.equal(merged.googleApiKey, 'admin-google');
});

test('mergeApiKeys treats whitespace-only customer keys as empty', () => {
  const merged = mergeApiKeys(
    { openaiApiKey: '   ' },
    { openai: 'admin-openai', google: '', anthropic: '', openrouter: '' }
  );
  assert.equal(merged.openaiApiKey, 'admin-openai');
});

test('mergeApiKeys returns a new object and does not mutate input', () => {
  const customer = { openaiApiKey: 'c-key', model: 'x' };
  const admin = { openai: 'a-key', google: '', anthropic: '', openrouter: '' };
  const merged = mergeApiKeys(customer, admin);
  assert.notEqual(merged, customer);
  assert.equal(customer.googleApiKey, undefined, 'customer object is untouched');
});

test('mergeApiKeys handles missing admin keys gracefully', () => {
  const merged = mergeApiKeys({ openaiApiKey: 'c' }, null);
  assert.equal(merged.openaiApiKey, 'c');
  assert.equal(merged.googleApiKey, '');
});

test('mergeApiKeys handles missing customer config gracefully', () => {
  const merged = mergeApiKeys(null, { openai: 'a', google: 'b', anthropic: '', openrouter: '' });
  assert.equal(merged.openaiApiKey, 'a');
  assert.equal(merged.googleApiKey, 'b');
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
node --test tests/api-keys-resolver.test.js
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/services/config/api-keys-resolver.js`**

```javascript
'use strict';

const PROVIDERS = [
  { admin: 'openai',     config: 'openaiApiKey' },
  { admin: 'google',     config: 'googleApiKey' },
  { admin: 'anthropic',  config: 'anthropicApiKey' },
  { admin: 'openrouter', config: 'openrouterApiKey' },
];

function mergeApiKeys(customerConfig, adminKeys) {
  const customer = customerConfig || {};
  const admin = adminKeys || {};
  const merged = { ...customer };
  for (const p of PROVIDERS) {
    const customerKey = String(customer[p.config] || '').trim();
    const adminKey = String(admin[p.admin] || '').trim();
    merged[p.config] = customerKey || adminKey;
  }
  return merged;
}

module.exports = { mergeApiKeys, PROVIDERS };
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
node --test tests/api-keys-resolver.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite**

```bash
npm test
```
Expected: `pass 214`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/services/config/api-keys-resolver.js tests/api-keys-resolver.test.js
git commit -m "feat(config): add api-keys-resolver that merges admin + customer keys"
```

---

## Task 4: Wire the resolver into bot config loading

**Files:**
- Modify: `src/services/bot/runtime-bot.js` (in the config-loading path)
- Modify: `src/workers/ai-worker.js` (where it reads config before AIClient)
- Create: `tests/runtime-bot-admin-key-merge.test.js`

**Note:** First inspect `src/services/bot/runtime-bot.js` to find where `this.config` is loaded from `bot_configs`, and `src/workers/ai-worker.js` to find where it calls AIClient. The merge must happen *after* loading from DB and *before* the config reaches AIClient.

- [ ] **Step 1: Read the current loading code**

```bash
grep -n "loadConfig\|new AIClient\|bot_configs\|getUserBot" src/services/bot/runtime-bot.js src/workers/ai-worker.js
```
Identify the exact function(s) that build the final config object handed to AIClient.

- [ ] **Step 2: Write the failing test**

Create `tests/runtime-bot-admin-key-merge.test.js`. Adjust the require path and the exported function name based on what Step 1 reveals; the test below assumes a helper `resolveConfigForAI(userId, deps)` will be exposed from `src/services/bot/runtime-bot.js` (or wherever the config is composed for AIClient):

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// NOTE: adjust this import after Step 1 inspection
const { resolveConfigForAI } = require('../src/services/bot/runtime-bot');

test('resolveConfigForAI falls back to admin key when customer config is empty', async () => {
  const deps = {
    loadBotConfig: async () => ({ model: 'google/gemini-2.0-flash', openaiApiKey: '', googleApiKey: '' }),
    loadAdminKeys: async () => ({ openai: 'admin-openai', google: 'admin-google', anthropic: '', openrouter: '' }),
  };
  const cfg = await resolveConfigForAI('user-1', deps);
  assert.equal(cfg.openaiApiKey, 'admin-openai');
  assert.equal(cfg.googleApiKey, 'admin-google');
});

test('resolveConfigForAI keeps customer override when set', async () => {
  const deps = {
    loadBotConfig: async () => ({ openaiApiKey: 'customer-openai' }),
    loadAdminKeys: async () => ({ openai: 'admin-openai', google: '', anthropic: '', openrouter: '' }),
  };
  const cfg = await resolveConfigForAI('user-1', deps);
  assert.equal(cfg.openaiApiKey, 'customer-openai');
});
```

- [ ] **Step 3: Run the test — expect FAIL**

```bash
node --test tests/runtime-bot-admin-key-merge.test.js
```
Expected: FAIL — `resolveConfigForAI` does not exist.

- [ ] **Step 4: Add `resolveConfigForAI` in the appropriate file**

In `src/services/bot/runtime-bot.js` (or the equivalent module identified in Step 1), add a new exported function that:

```javascript
const { mergeApiKeys } = require('../config/api-keys-resolver');
const { getAllAdminApiKeys } = require('../admin/admin-api-keys');

async function resolveConfigForAI(userId, deps = {}) {
  const loadBotConfig = deps.loadBotConfig || (async () => {
    // existing logic that reads bot_configs.config for this userId
    // copy from current loadConfig implementation
  });
  const loadAdminKeys = deps.loadAdminKeys || getAllAdminApiKeys;
  const [customer, admin] = await Promise.all([loadBotConfig(userId), loadAdminKeys()]);
  return mergeApiKeys(customer, admin);
}

module.exports = {
  // ...existing exports,
  resolveConfigForAI,
};
```

Then wire the AI worker to use it. In `src/workers/ai-worker.js`, replace the call site that builds the config for `new AIClient(config, logger)` so that the config passed in is the result of `resolveConfigForAI(userId)` rather than a raw `bot.config` read.

**Important:** Do NOT change the AIClient internals or its tests. The merged config has the same shape as before — only the source of the keys changes.

- [ ] **Step 5: Run the new test — expect PASS**

```bash
node --test tests/runtime-bot-admin-key-merge.test.js
```
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite**

```bash
npm test
```
Expected: `pass 216`, `fail 0`. **If ANY previously-passing test now fails, stop and investigate. Most likely you accidentally changed AIClient or its test fixtures.**

- [ ] **Step 7: Commit**

```bash
git add src/services/bot/runtime-bot.js src/workers/ai-worker.js tests/runtime-bot-admin-key-merge.test.js
git commit -m "feat(bot): merge admin API keys into config before AIClient"
```

---

## Task 5: Admin API endpoints — get / put global keys

**Files:**
- Modify: `src/routes/admin.routes.js` (add three new routes)
- Create: `tests/admin-api-keys-routes.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/admin-api-keys-routes.test.js`. This is a route handler unit test that exercises the handlers directly with a fake `req`/`res`, mirroring the style of existing route tests in this repo:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminApiKeysHandlers } = require('../src/routes/admin.routes');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

test('GET /api/admin/api-keys returns masked keys', async () => {
  const deps = {
    getAdminApiKeysMasked: async () => ({
      openai: 'sk-proj-••••mnop',
      google: 'AIza••••OpQr',
      anthropic: null,
      openrouter: null,
    }),
  };
  const { getApiKeys } = createAdminApiKeysHandlers(deps);
  const res = fakeRes();
  await getApiKeys({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    keys: {
      openai: 'sk-proj-••••mnop',
      google: 'AIza••••OpQr',
      anthropic: null,
      openrouter: null,
    },
  });
});

test('PUT /api/admin/api-keys sets a single provider key', async () => {
  const calls = [];
  const deps = {
    setAdminApiKey: async (provider, key, adminId) => { calls.push({ provider, key, adminId }); return { provider, cleared: false }; },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'openai', apiKey: 'sk-new' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(calls, [{ provider: 'openai', key: 'sk-new', adminId: 'admin-1' }]);
});

test('PUT /api/admin/api-keys rejects unknown providers with 400', async () => {
  const deps = {
    setAdminApiKey: async () => { throw new Error('provider غير مدعوم'); },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'foobar', apiKey: 'x' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('PUT /api/admin/api-keys with empty key clears the slot', async () => {
  const calls = [];
  const deps = {
    setAdminApiKey: async (provider, key) => { calls.push({ provider, key }); return { provider, cleared: true }; },
  };
  const { putApiKey } = createAdminApiKeysHandlers(deps);
  const req = { body: { provider: 'openai', apiKey: '' }, session: { userId: 'admin-1' } };
  const res = fakeRes();
  await putApiKey(req, res);
  assert.equal(res.body.cleared, true);
  assert.deepEqual(calls, [{ provider: 'openai', key: '' }]);
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
node --test tests/admin-api-keys-routes.test.js
```
Expected: FAIL — `createAdminApiKeysHandlers` is not exported.

- [ ] **Step 3: Add handlers in `src/routes/admin.routes.js`**

Near the top of the file (after existing requires), add:

```javascript
const { setAdminApiKey, getAdminApiKeysMasked } = require('../services/admin/admin-api-keys');
```

Add a factory function that produces the handlers (mirror the existing `canOpenAdminConsole`/factory style):

```javascript
function createAdminApiKeysHandlers(deps = {}) {
  const getMasked = deps.getAdminApiKeysMasked || getAdminApiKeysMasked;
  const setKey = deps.setAdminApiKey || setAdminApiKey;

  async function getApiKeys(req, res) {
    try {
      const keys = await getMasked();
      res.status(200).json({ success: true, keys });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async function putApiKey(req, res) {
    try {
      const { provider, apiKey } = req.body || {};
      const result = await setKey(provider, apiKey, req.session?.userId);
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      const isClient = /provider/i.test(err.message);
      res.status(isClient ? 400 : 500).json({ success: false, message: err.message });
    }
  }

  return { getApiKeys, putApiKey };
}
```

Inside `createAdminRoutes(deps)`, after the existing admin endpoints, register them:

```javascript
const apiKeyHandlers = createAdminApiKeysHandlers();
router.get('/api/admin/api-keys', requireOwner, apiKeyHandlers.getApiKeys);
router.put('/api/admin/api-keys', requireOwner, apiKeyHandlers.putApiKey);
```

Finally, export the factory:

```javascript
module.exports = {
  // ...existing exports,
  createAdminApiKeysHandlers,
};
```

- [ ] **Step 4: Run the new test — expect PASS**

```bash
node --test tests/admin-api-keys-routes.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Run full suite**

```bash
npm test
```
Expected: `pass 220`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.routes.js tests/admin-api-keys-routes.test.js
git commit -m "feat(admin): add GET/PUT /api/admin/api-keys endpoints"
```

---

## Task 6: Strip API keys from customer config response (GET /api/config)

**Files:**
- Modify: `src/controllers/config.controller.js` (in the GET handler)
- Modify: `src/server.js` (the inline GET /api/config route if present — confirm via grep)
- Create: `tests/config-controller-no-key-leak.test.js`

- [ ] **Step 1: Map the customer GET /api/config code path**

```bash
grep -n "GET\|getConfig\|app.get.*config\|router.get.*config" src/server.js src/controllers/config.controller.js src/routes/config.routes.js 2>/dev/null
```

Identify the exact handler that returns `bot.config` (or a copy of it) to the customer dashboard.

- [ ] **Step 2: Write the failing test**

Create `tests/config-controller-no-key-leak.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripApiKeysFromConfig } = require('../src/controllers/config.controller');

test('stripApiKeysFromConfig removes all four API key fields', () => {
  const input = {
    openaiApiKey: 'sk-1',
    googleApiKey: 'AIza-1',
    anthropicApiKey: 'sk-ant-1',
    openrouterApiKey: 'sk-or-1',
    model: 'google/gemini-2.0-flash',
    botInstructions: 'hello',
  };
  const out = stripApiKeysFromConfig(input);
  assert.equal(out.openaiApiKey, undefined);
  assert.equal(out.googleApiKey, undefined);
  assert.equal(out.anthropicApiKey, undefined);
  assert.equal(out.openrouterApiKey, undefined);
  assert.equal(out.model, 'google/gemini-2.0-flash', 'non-key fields preserved');
  assert.equal(out.botInstructions, 'hello');
});

test('stripApiKeysFromConfig returns a new object and does not mutate input', () => {
  const input = { openaiApiKey: 'sk-1', model: 'x' };
  const out = stripApiKeysFromConfig(input);
  assert.notEqual(out, input);
  assert.equal(input.openaiApiKey, 'sk-1', 'input unchanged');
});

test('stripApiKeysFromConfig handles null/undefined input', () => {
  assert.deepEqual(stripApiKeysFromConfig(null), {});
  assert.deepEqual(stripApiKeysFromConfig(undefined), {});
});
```

- [ ] **Step 3: Run the test — expect FAIL**

```bash
node --test tests/config-controller-no-key-leak.test.js
```
Expected: FAIL — function does not exist.

- [ ] **Step 4: Add the helper and use it in the GET handler**

In `src/controllers/config.controller.js`, add at the top of the file:

```javascript
const API_KEY_FIELDS = ['openaiApiKey', 'googleApiKey', 'anthropicApiKey', 'openrouterApiKey'];

function stripApiKeysFromConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const out = { ...config };
  for (const k of API_KEY_FIELDS) delete out[k];
  return out;
}
```

In the GET handler (the one returning `bot.config` to the dashboard), replace the response payload with `stripApiKeysFromConfig(bot.config)`.

If `src/server.js` has an inline route doing the same, update it the same way (import the helper from the controller or duplicate the field list locally with a shared constant).

Export the helper:

```javascript
module.exports = {
  // ...existing exports,
  stripApiKeysFromConfig,
  API_KEY_FIELDS,
};
```

- [ ] **Step 5: Run the new test — expect PASS**

```bash
node --test tests/config-controller-no-key-leak.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 6: Run full suite**

```bash
npm test
```
Expected: `pass 223`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/config.controller.js src/server.js tests/config-controller-no-key-leak.test.js
git commit -m "feat(config): redact API keys from customer GET /api/config response"
```

---

## Task 7: Reject API keys in customer POST /api/config (silent strip for non-admin)

**Files:**
- Modify: `src/controllers/config.controller.js` (save handler)
- Modify: `src/server.js` (the inline POST /api/config block at line ~211, if still present)
- Create: `tests/config-controller-save-strips-keys.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/config-controller-save-strips-keys.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeConfigForSave } = require('../src/controllers/config.controller');

test('mergeConfigForSave drops API key fields from incoming body when isAdmin=false', () => {
  const existing = { model: 'x', openaiApiKey: 'admin-set-earlier' };
  const incoming = { model: 'y', openaiApiKey: 'attacker-tries-to-set', botInstructions: 'hi' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: false });
  assert.equal(merged.model, 'y');
  assert.equal(merged.botInstructions, 'hi');
  assert.equal(merged.openaiApiKey, 'admin-set-earlier', 'existing key kept, incoming ignored');
});

test('mergeConfigForSave allows API keys when isAdmin=true', () => {
  const existing = { openaiApiKey: 'old' };
  const incoming = { openaiApiKey: 'new-admin-value' };
  const merged = mergeConfigForSave({ existing, incoming, isAdmin: true });
  assert.equal(merged.openaiApiKey, 'new-admin-value');
});

test('mergeConfigForSave preserves non-key fields normally', () => {
  const merged = mergeConfigForSave({
    existing: { a: 1 },
    incoming: { b: 2 },
    isAdmin: false,
  });
  assert.deepEqual(merged, { a: 1, b: 2 });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test tests/config-controller-save-strips-keys.test.js
```

- [ ] **Step 3: Implement `mergeConfigForSave` in `src/controllers/config.controller.js`**

```javascript
function mergeConfigForSave({ existing, incoming, isAdmin }) {
  const existingObj = existing || {};
  const incomingObj = incoming || {};
  const filteredIncoming = { ...incomingObj };
  if (!isAdmin) {
    for (const k of API_KEY_FIELDS) delete filteredIncoming[k];
  }
  return { ...existingObj, ...filteredIncoming };
}
```

Wire it into the existing save handler: replace the current `const merged = { ...bot.config, ...incoming };` line with:

```javascript
const isAdmin = req.session?.isAdmin === true;
const merged = mergeConfigForSave({ existing: bot.config, incoming, isAdmin });
```

Remove the four `if (!incoming.openaiApiKey?.trim() && bot.config.openaiApiKey?.trim()) merged.openaiApiKey = bot.config.openaiApiKey;` lines (they become unnecessary — `mergeConfigForSave` preserves existing for non-admin).

Apply the same change to `src/server.js` lines ~211-215 if that duplicate save path still exists.

Export:

```javascript
module.exports = {
  // ...,
  mergeConfigForSave,
};
```

- [ ] **Step 4: Run new test — PASS**

```bash
node --test tests/config-controller-save-strips-keys.test.js
```

- [ ] **Step 5: Full suite**

```bash
npm test
```
Expected: `pass 226`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/config.controller.js src/server.js tests/config-controller-save-strips-keys.test.js
git commit -m "feat(config): reject API key writes from non-admin customers"
```

---

## Task 8: Remove API key inputs from customer dashboard

**Files:**
- Modify: `dashboard/index.html` (lines 989-1025 input fields; lines 1852-1855 load logic; lines 2380-2383 save logic)
- Create: `tests/dashboard-no-api-key-inputs.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-no-api-key-inputs.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8'
);

test('customer dashboard has no openaiKeyInput element', () => {
  assert.equal(html.includes('id="openaiKeyInput"'), false);
  assert.equal(html.includes("getElementById('openaiKeyInput')"), false);
});

test('customer dashboard has no googleKeyInput element', () => {
  assert.equal(html.includes('id="googleKeyInput"'), false);
  assert.equal(html.includes("getElementById('googleKeyInput')"), false);
});

test('customer dashboard has no anthropicKeyInput element', () => {
  assert.equal(html.includes('id="anthropicKeyInput"'), false);
  assert.equal(html.includes("getElementById('anthropicKeyInput')"), false);
});

test('customer dashboard has no openrouterKeyInput element', () => {
  assert.equal(html.includes('id="openrouterKeyInput"'), false);
  assert.equal(html.includes("getElementById('openrouterKeyInput')"), false);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test tests/dashboard-no-api-key-inputs.test.js
```

- [ ] **Step 3: Remove the inputs**

In `dashboard/index.html`:
1. Find the API keys section around lines 989-1025 (search for `googleKeyInput`). Delete the entire visible HTML block that contains the four password inputs and their labels.
2. In the load function around lines 1852-1855, delete the four lines that do `document.getElementById('xxxKeyInput').value = c.xxxApiKey || ''`.
3. In the save function around lines 2380-2383, delete the four lines that read from those inputs into `nc`.

Replace the visible section (where the inputs were) with a small notice card:

```html
<div class="setting-card setting-card-info">
  <div class="setting-card-header">
    <h3>مفاتيح AI</h3>
  </div>
  <p class="muted">مفاتيح الذكاء الاصطناعي يديرها فريق ردّي. لا حاجة لإدخالها هنا.</p>
</div>
```

(Use whatever class names already exist in the file for setting cards — adapt to match the surrounding style.)

- [ ] **Step 4: Run new test — PASS**

```bash
node --test tests/dashboard-no-api-key-inputs.test.js
```

- [ ] **Step 5: Full suite**

```bash
npm test
```
Expected: `pass 230`, `fail 0`.

- [ ] **Step 6: Manually verify in browser**

```bash
npm run dev
```
Open `http://localhost:3000`, log in as a normal user, open the settings page, and confirm:
- No API key input fields are visible.
- A notice card explains the keys are managed by the platform.
- Saving other settings (model selection, instructions, products) still works.

- [ ] **Step 7: Commit**

```bash
git add dashboard/index.html tests/dashboard-no-api-key-inputs.test.js
git commit -m "feat(dashboard): remove API key inputs from customer settings"
```

---

## Task 9: Add API keys management UI to the admin dashboard

**Files:**
- Modify: `dashboard/admin.html`
- Create: `tests/admin-dashboard-has-api-keys-section.test.js`

- [ ] **Step 1: Inspect current admin.html structure**

```bash
node -e "const s=require('fs').readFileSync('dashboard/admin.html','utf8'); console.log(s.length, 'chars'); console.log(s.slice(0,500));"
```

Identify where to insert a new section (e.g., after the customers list, before incidents).

- [ ] **Step 2: Write the failing test**

Create `tests/admin-dashboard-has-api-keys-section.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'admin.html'),
  'utf8'
);

test('admin dashboard contains an api-keys section', () => {
  assert.match(html, /id="adminApiKeysSection"|class="admin-api-keys"/);
});

test('admin dashboard has inputs for all four providers', () => {
  assert.match(html, /id="adminOpenaiKeyInput"/);
  assert.match(html, /id="adminGoogleKeyInput"/);
  assert.match(html, /id="adminAnthropicKeyInput"/);
  assert.match(html, /id="adminOpenrouterKeyInput"/);
});

test('admin dashboard calls GET /api/admin/api-keys somewhere', () => {
  assert.ok(
    html.includes('/api/admin/api-keys'),
    'expected admin.html to reference /api/admin/api-keys endpoint'
  );
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
node --test tests/admin-dashboard-has-api-keys-section.test.js
```

- [ ] **Step 4: Add the section to admin.html**

Insert (matching the surrounding style) something like:

```html
<section id="adminApiKeysSection" class="admin-card">
  <header class="admin-card-header">
    <h2>مفاتيح AI العامة</h2>
    <p class="muted">هذي المفاتيح تُستخدم لكل العملاء بشكل افتراضي. لو حطيت مفتاح خاص لعميل معين، يطغى على العام.</p>
  </header>
  <div class="admin-keys-form">
    <label>OpenAI
      <input type="password" id="adminOpenaiKeyInput" placeholder="sk-proj-..." autocomplete="off">
      <span class="key-status" id="adminOpenaiKeyStatus"></span>
      <button type="button" data-provider="openai" class="save-key-btn">حفظ</button>
    </label>
    <label>Google AI
      <input type="password" id="adminGoogleKeyInput" placeholder="AIza..." autocomplete="off">
      <span class="key-status" id="adminGoogleKeyStatus"></span>
      <button type="button" data-provider="google" class="save-key-btn">حفظ</button>
    </label>
    <label>Anthropic
      <input type="password" id="adminAnthropicKeyInput" placeholder="sk-ant-..." autocomplete="off">
      <span class="key-status" id="adminAnthropicKeyStatus"></span>
      <button type="button" data-provider="anthropic" class="save-key-btn">حفظ</button>
    </label>
    <label>OpenRouter
      <input type="password" id="adminOpenrouterKeyInput" placeholder="sk-or-..." autocomplete="off">
      <span class="key-status" id="adminOpenrouterKeyStatus"></span>
      <button type="button" data-provider="openrouter" class="save-key-btn">حفظ</button>
    </label>
  </div>
</section>
```

And the JS (place inside the existing admin.html `<script>` block or its DOMContentLoaded handler):

```html
<script>
(async function initAdminApiKeys() {
  async function loadMasked() {
    const r = await fetch('/api/admin/api-keys', { credentials: 'same-origin' });
    if (!r.ok) return;
    const { keys } = await r.json();
    document.getElementById('adminOpenaiKeyStatus').textContent     = keys.openai     ? `محفوظ: ${keys.openai}`     : 'فارغ';
    document.getElementById('adminGoogleKeyStatus').textContent     = keys.google     ? `محفوظ: ${keys.google}`     : 'فارغ';
    document.getElementById('adminAnthropicKeyStatus').textContent  = keys.anthropic  ? `محفوظ: ${keys.anthropic}`  : 'فارغ';
    document.getElementById('adminOpenrouterKeyStatus').textContent = keys.openrouter ? `محفوظ: ${keys.openrouter}` : 'فارغ';
  }
  await loadMasked();
  document.querySelectorAll('.save-key-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const input = document.getElementById(`admin${provider.charAt(0).toUpperCase()+provider.slice(1)}KeyInput`);
      const apiKey = input.value.trim();
      const r = await fetch('/api/admin/api-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await r.json();
      if (data.success) {
        input.value = '';
        await loadMasked();
      } else {
        alert(data.message || 'فشل الحفظ');
      }
    });
  });
})();
</script>
```

- [ ] **Step 5: Run new test — PASS**

```bash
node --test tests/admin-dashboard-has-api-keys-section.test.js
```

- [ ] **Step 6: Full suite**

```bash
npm test
```
Expected: `pass 233`, `fail 0`.

- [ ] **Step 7: Manual verify**

```bash
npm run dev
```
- Log in as admin via the secret admin path.
- Open the admin dashboard, see the new "مفاتيح AI العامة" section.
- Enter a test OpenAI key, click حفظ, confirm the status flips to `محفوظ: sk-proj-••••XXXX`.
- Re-fetch the page: confirm the masked value persists.
- Log out, log in as a customer, confirm their settings page does NOT show key inputs and AI replies still work.

- [ ] **Step 8: Commit**

```bash
git add dashboard/admin.html tests/admin-dashboard-has-api-keys-section.test.js
git commit -m "feat(admin-ui): add API keys management section to admin dashboard"
```

---

## Task 10: Final regression sweep + PR

- [ ] **Step 1: Run the entire test suite from scratch**

```bash
npm test
```
Expected: `pass 233` (or whatever total the prior tasks reached), `fail 0`.

- [ ] **Step 2: Smoke-test the AI worker end-to-end**

With admin keys set, send a test WhatsApp message through the normal flow (or use the existing dev harness if available) and confirm AI replies arrive. If a customer has no per-customer override, the admin global key MUST be used.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin claude/crazy-greider-e7e237
gh pr create --title "feat: admin-controlled API keys (global + per-customer override)" --body "$(cat <<'EOF'
## Summary
- New `admin_api_keys` table for platform-wide API keys.
- Customers no longer see or input API keys in the settings page.
- Admin dashboard gains a `مفاتيح AI العامة` section to manage the global pool.
- Resolution order at AI call time: per-customer override → admin global → throw with a clear message.
- AIClient internals untouched — keys are merged in `resolveConfigForAI` before construction.

## Test plan
- [ ] All existing tests pass.
- [ ] New tests cover: schema, masking, resolver merge, route handlers, dashboard input absence, admin UI presence.
- [ ] Manual verify: customer settings page has no key inputs; admin can save & re-read masked keys; AI replies work using admin key.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for review**

Do not merge until the user approves the PR.

---

## Rollback plan

If anything breaks in production after merge:

1. `git revert <merge-commit>` and redeploy — the migration is additive (`CREATE TABLE IF NOT EXISTS`) so it does not need to be reverted at the DB level.
2. Customer dashboard will regain its API key inputs (revert restores them).
3. AI worker will go back to reading keys from `bot_configs.config` only — and since the customer override column was never removed, existing customer keys continue to work.

The new `admin_api_keys` table can be left in place; it is dormant when no code reads from it.

---

## Notes for future plans (out of scope here)

- **Encryption-at-rest** for stored API keys (HIGH security issue from the audit) — separate plan.
- **bcrypt + rate-limit** for admin password (CRITICAL #4) — separate plan.
- **Outgoing message saving** (CRITICAL #1) — separate plan.
- **@lid send protection** (CRITICAL #3) — separate plan.
- **440 lease lock** (CRITICAL #2) — separate plan.
- **Conversations page WhatsApp Web redesign** — separate plan.
