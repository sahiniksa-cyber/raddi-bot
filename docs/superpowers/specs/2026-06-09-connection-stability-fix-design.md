# Connection Stability Fix — Bad MAC, Disconnects, Duplicate Replies

**Date:** 2026-06-09
**Branch:** `claude/hungry-merkle-3e46f6`
**Status:** Design — pending user approval

## 1. Problem

Production users (jwap.net) report three symptoms over the past 48 hours:

1. **Bot disconnects for 30 minutes to several hours**, then recovers on its own. WhatsApp shows "the bot is reconnecting."
2. **Duplicate replies within the same second** — the bot replies twice to a single inbound message.
3. **The bot occasionally ignores prompt instructions** (a separate brain-level concern, scoped OUT of this spec).

Railway logs show hundreds of `Session error: Error: Bad MAC` lines from `libsignal/session_cipher.js`, interspersed with `Closing open session in favor of incoming prekey bundle` and `closed: -1` socket deaths. Railway has hit its log rate limit (`Messages dropped: 265`), erasing visibility into what happened around the failures.

## 2. Root Cause — The Five-Way Cascade

Independent code-review of `baileys-connection-manager.js`, `baileys-postgres-auth.js`, `runtime-bot.js`, `outgoing-whatsapp-worker.js`, plus a research pass on `@whiskeysockets/baileys@7.0.0-rc.10` upstream, identifies five compounding causes. Each is small; together they produce the multi-hour outage.

### C1 — Missing `getMessage` callback

`makeWASocket(...)` in [baileys-connection-manager.js:237-254](../../src/services/whatsapp/baileys-connection-manager.js) does not pass `getMessage`. When a peer fails to decrypt one of our outbound replies (network blip, broken ratchet), it sends a *retry receipt*. Without `getMessage`, the lib returns `undefined`, the peer sees a placeholder, gives up on the existing Signal session, and forces a new prekey bundle — `Closing open session in favor of incoming prekey bundle`. Every in-flight message on the OLD session now decrypts to **Bad MAC** at our end.

### C2 — `messages.upsert` does not check `socketGeneration`

`handleConnectionUpdate` guards against late events from a previous socket via `socketGeneration`, but `handleMessages` (line 270, 501-533) does not. After a reconnect, ghost messages from a dying socket can be ingested by the new socket's pipeline → AI worker generates a reply, then the new socket's normal delivery generates a second reply for the same message ID. Result: **two replies in the same second**.

### C3 — `libsignal` writes Bad MAC stack traces straight to `stderr`

`node_modules/libsignal/src/session_cipher.js` uses `console.error('Session error:', e)`. This bypasses our `pino({ level: 'silent' })` logger entirely. Each Bad MAC event prints 5–6 lines of stack. A burst of 200 Bad MAC events = 1000+ stderr lines in seconds → Railway throttles → we lose visibility for the rest of the failure window.

### C4 — Keystore persist is whole-blob on every ratchet step

[baileys-postgres-auth.js:54-72](../../src/services/whatsapp/baileys-postgres-auth.js) writes the ENTIRE `creds + keys` object as one JSONB column on every `set()` call. With ~1000 accumulated signal keys (normal after weeks of running), each inbound message triggers 2–4 writes of multi-MB JSON. Under stress this saturates DB I/O, stalls the event loop, and makes the WebSocket keepalive fail → `closed: -1` socket death → reconnect → resync → repeat.

### C5 — `outgoing-whatsapp-worker.js` touches `bot.sock` directly

Lines 150, 163, 213 call `bot.sock.sendPresenceUpdate(...)` and `bot.sock.sendMessage(...)` directly instead of going through `bot.client.sendMessage`. After a reconnect, `bot.sock` may be the OLD socket reference (the connection manager replaces `this.sock` but the worker captured the old one). Send attempts on a dead socket throw, get retried, and consume reply-budget while the customer waits.

## 3. Goals & Non-Goals

**Goals**
- Eliminate the Bad MAC cascade by giving the peer what it asks for during retry receipts.
- Stop ghost messages from old sockets after reconnect.
- Restore Railway log visibility during failures.
- Reduce DB write pressure on the keystore by 90%+.
- Make the outgoing worker safe against socket replacement.
- All fixes in a single focused PR. Verified by `node --test` before merge.

**Non-goals**
- Upgrading Baileys (`rc.10 → rc.13`). The upstream changelog shows zero Bad MAC fixes between these versions; we'll do the upgrade as a separate PR a few days later for the security patch.
- Fixing the "bot ignores prompt" symptom — separate concern, separate session.
- Adding new dashboard metrics (out of scope; current alerts suffice).
- Reworking the lease/`scheduleReconnect` logic — recent PRs #48/#56/#57/#58 already cover that ground.

## 4. Architecture & Components

Five surgical changes, each isolated to one or two files. Tests for each.

### 4.1 — `getMessage` handler reads from `messages` table

**File:** `src/services/whatsapp/baileys-connection-manager.js`
**Depends on:** §4.6 (the `whatsapp_message_id` column must exist first).

Add a `getMessage` callback in the `makeWASocket(...)` options that returns the `content` of the outbound assistant message matching `key.id`, wrapped as a `proto.Message` shape:

```js
getMessage: async (key) => {
  if (!key?.id) return undefined;
  try {
    const row = await this.db.query(
      `SELECT content FROM messages
       WHERE user_id = $1 AND whatsapp_message_id = $2
       LIMIT 1`,
      [this.userId, String(key.id)],
    );
    const text = row?.rows?.[0]?.content;
    return text ? { conversation: String(text) } : undefined;
  } catch (err) {
    this.log('warn', 'getMessage', `lookup failed for ${key.id}: ${err.message}`);
    return undefined;
  }
}
```

Returning `undefined` is safe — Baileys falls back to a placeholder and the peer eventually moves on. Returning the real text is what kills the Bad MAC cascade: the peer decrypts, the Signal session stays healthy.

**Implementation order:** §4.6 (schema + record-on-send) ships in the same PR but executes before §4.1 in the migration sequence. Until the migration completes on a deployed environment, `getMessage` returns `undefined` (the column exists empty, `WHERE` matches nothing) — equivalent to today's behavior. After the migration runs and the next outbound message is sent, lookups start succeeding.

### 4.2 — `socketGeneration` guard on `messages.upsert`

**File:** `src/services/whatsapp/baileys-connection-manager.js`

Capture `socketGeneration` in the listener closure, drop the event if the generation has rolled over:

```js
sock.ev.on('messages.upsert', (event) => {
  if (socketGeneration !== this._socketGeneration) {
    this.log('info', 'message', `dropped messages.upsert from generation=${socketGeneration} current=${this._socketGeneration}`);
    return;
  }
  this.handleMessages(event);
});
```

Mirrors what `handleConnectionUpdate` already does. Zero risk; pure dedup of stale events.

### 4.3 — `libsignal` log throttle

**File:** `src/runtime/start-all.js` (top-level, before `processes` definition)

Monkey-patch `console.error` and `console.log` once at process start to detect libsignal lines (signature: stack frames containing `libsignal/src/session_cipher.js` OR first arg starts with `'Session error:'`). Aggregate counts and emit ONE summary line per 60 seconds:

```js
const libsignalCounts = new Map();
let libsignalSummaryTimer = null;
const origErr = console.error.bind(console);
console.error = (...args) => {
  const first = String(args[0] ?? '');
  const stack = args[1]?.stack || '';
  if (first.startsWith('Session error') || /libsignal[\\/]src[\\/]session_cipher/.test(stack)) {
    libsignalCounts.set('badmac', (libsignalCounts.get('badmac') || 0) + 1);
    if (!libsignalSummaryTimer) {
      libsignalSummaryTimer = setTimeout(() => {
        libsignalSummaryTimer = null;
        const total = Array.from(libsignalCounts.values()).reduce((a, b) => a + b, 0);
        if (total > 0) origErr(`[libsignal-throttle] suppressed ${total} Bad MAC errors in last 60s`);
        libsignalCounts.clear();
      }, 60000).unref();
    }
    return;
  }
  origErr(...args);
};
```

**Where to apply:** ONLY inside the child processes — top of `src/server.js` and `src/workers/ai-worker.js`, before any other `require`. Reason: `start-all.js` uses `stdio: 'inherit'`, which means each child writes directly to the parent's stdout/stderr file descriptor. The parent never sees the child's writes as JavaScript values, so patching `console.error` in the parent does nothing for the child's output. Each child must patch its own `console.error` and `console.log`. Extract the patch into `src/runtime/libsignal-log-throttle.js` and require it from both children at the top of the file.

Result: a burst of 500 Bad MAC events shows up as one line: `[libsignal-throttle] suppressed 500 Bad MAC errors in last 60s`. Railway never throttles. We keep visibility.

**Safety:** the patch is narrow — only suppresses when the error CLEARLY matches libsignal session errors. Everything else (real errors, our own `logger.error` paths, other libraries) passes through untouched. Tested by checking real `console.error` calls still print.

### 4.4 — Keystore debounce + write coalescing

**File:** `src/services/whatsapp/baileys-postgres-auth.js`

Replace the immediate `await this.persist()` in `set()` with a debounced persist:

```js
_schedulePersist() {
  if (this._persistDebounce) return;
  this._persistDebounce = setTimeout(() => {
    this._persistDebounce = null;
    this.persist().catch((err) => {
      console.error('[baileys-auth] persist failed:', err.message);
    });
  }, parseInt(process.env.WA_KEYSTORE_DEBOUNCE_MS || '500', 10));
  if (typeof this._persistDebounce.unref === 'function') this._persistDebounce.unref();
}
```

Then in `set()`: `this._schedulePersist()` instead of `await this.persist()`. In `saveCreds`: keep the immediate `await this.persist()` (creds changes are infrequent and critical).

**Critical:** the existing `flush()` must drain the pending debounce timer too:
```js
flush: async () => {
  if (this._persistDebounce) {
    clearTimeout(this._persistDebounce);
    this._persistDebounce = null;
    await this.persist();
  }
  for (let i = 0; i < 10; i++) {
    const q = this.writeQueue;
    try { await q; } catch (_) {}
    if (q === this.writeQueue) break;
  }
}
```

Result: 10 ratchet steps within 500ms collapse to one DB write. No correctness loss because `flush()` runs on shutdown (#58) and on every reconnect (added in §4.5).

### 4.5 — Flush keystore before scheduling reconnect

**File:** `src/services/whatsapp/baileys-connection-manager.js`

In `scheduleReconnect`, before assigning a new socket generation, await the pending flush. Same pattern as `stop()`:

```js
scheduleReconnect(retryCount, reason, socketGeneration = this._socketGeneration) {
  // ... existing checks ...
  const flush = this._authFlush;
  // ... existing socket teardown ...
  this._retryTimer = setTimeout(async () => {
    this._retryTimer = null;
    if (socketGeneration !== this._socketGeneration) return;
    if (this.ready || this.status === 'connected') return;
    if (flush) { try { await flush(); } catch (_) {} }   // ← NEW
    this._running = false;
    this.start(retryCount + 1).catch((err) => { ... });
  }, delay);
}
```

Result: between dying socket and new socket, all signal keys are durably on disk. A second-loop reconnect can't lose ratchet state.

### 4.6 — Outgoing worker uses live socket via wrapper, not captured `bot.sock`

**File:** `src/workers/outgoing-whatsapp-worker.js`

Replace direct `bot.sock.sendMessage(...)` and `bot.sock.sendPresenceUpdate(...)` with `bot.client.sendMessage(...)` and a new `bot.client.sendPresenceUpdate(...)` method.

**File:** `src/services/whatsapp/baileys-connection-manager.js`

Extend the `client` wrapper to expose presence:
```js
this.client = {
  sendMessage: async (target, text) => sock.sendMessage(normalizeOutboundJid(target), { text: String(text || '') }),
  sendPresenceUpdate: async (state, target) => sock.sendPresenceUpdate(state, normalizeOutboundJid(target)),
  getState: async () => (this.ready ? 'CONNECTED' : this.status.toUpperCase()),
};
```

**Why:** `this.client` is reassigned every time `start()` opens a new socket; `bot.sock` captured by the worker stays pinned to the old reference. After the change, the worker always uses the current socket via the wrapper.

**Also:** when an outbound `sendMessage` succeeds, record the returned WhatsApp message ID against our `provider_message_id`. Update `messages` schema:

```sql
-- migration: add whatsapp_message_id column
ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(user_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;
```

Then in §4.1 the `getMessage` query becomes a clean equality:
```js
const row = await this.db.query(
  `SELECT content FROM messages
   WHERE user_id = $1 AND whatsapp_message_id = $2
   LIMIT 1`,
  [this.userId, key.id],
);
```

This is the only DB schema change in the PR; small, additive, safe.

## 5. Data Flow

```
Inbound message → Baileys → messages.upsert
                         ↓ [§4.2: drop if generation stale]
                       handleMessages → ingest

Peer fails to decrypt one of OUR sent replies
        → sends retry receipt to WhatsApp server
        → server asks our socket: "resend message X"
        → Baileys calls getMessage(key) [§4.1]
        → reads messages.content by whatsapp_message_id [§4.6 schema]
        → returns { conversation: text }
        → Baileys re-encrypts and resends
        → peer decrypts successfully
        → NO new prekey bundle, NO Bad MAC cascade

Outbound: AI worker → outgoing queue
                   → outgoing-whatsapp-worker
                   → bot.client.sendMessage (always live socket) [§4.6]
                   → record returned whatsapp_message_id [§4.6]

Keystore writes:
  set() → schedulePersist (debounced 500ms) [§4.4]
  saveCreds() → immediate persist (unchanged)
  scheduleReconnect → await flush() before new socket [§4.5]
  stop() → await flush() (unchanged from #58)

libsignal stderr → console.error [§4.3 patched]
                → if Bad MAC: count, summary every 60s
                → else: pass through
```

## 6. Testing

Every change needs a `node --test` unit test. No live WhatsApp connection in tests.

| § | Test file | What it asserts |
|---|---|---|
| 4.1 | `tests/baileys-get-message.test.js` (new) | `getMessage` returns `{conversation: '...'}` for known ID, `undefined` for unknown, never throws |
| 4.2 | `tests/baileys-message-generation-guard.test.js` (new) | `messages.upsert` from stale generation is dropped; current generation processes normally |
| 4.3 | `tests/libsignal-log-throttle.test.js` (new) | Bad MAC lines are suppressed; non-Bad-MAC `console.error` calls pass through; summary emitted after 60s |
| 4.4 | `tests/baileys-auth-state.test.js` (extend) | 10 rapid `set()` calls coalesce to 1 DB write; `flush()` drains the pending debounce |
| 4.5 | `tests/connection-fixes.test.js` (extend) | `scheduleReconnect` awaits `flush()` before opening a new socket |
| 4.6 | `tests/outgoing-whatsapp-worker.test.js` (extend) | Worker uses `bot.client.sendMessage`, not `bot.sock`; records `whatsapp_message_id` on success |
| migration | `tests/migrations.test.js` (extend) | `whatsapp_message_id` column added idempotently; index created |

## 7. Rollout & Verification

1. Branch from `origin/master`, run all tests, push, open PR.
2. Squash-merge to master. Railway deploys.
3. **DO NOT touch anything for 3 hours** after deploy. The platform needs to stabilize.
4. After 3 hours, verify in Railway logs:
   - `[libsignal-throttle] suppressed N Bad MAC errors in last 60s` appears (or N=0 if healthy)
   - No `Messages dropped` lines
   - No raw `Session error: Bad MAC` lines (the throttle eats them)
   - Connection stays connected for 30+ minutes between heartbeat updates
5. Check the dashboard health endpoint: `aiActive` should drop to 0, queue should stay low.
6. Test the start button manually — it should still steal-the-lease and connect within seconds (PR #57 behavior preserved).

## 8. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Keystore debounce loses keys if Node crashes mid-debounce | Low | `flush()` on shutdown (#58) and on reconnect (§4.5). 500ms is a small loss window. Adjustable via `WA_KEYSTORE_DEBOUNCE_MS`. |
| `console.error` patch suppresses a real bug | Low | Pattern is narrow (`Session error` OR `libsignal/src/session_cipher` in stack). Audited in test. |
| `getMessage` query slow under load | Low | Indexed lookup by `(user_id, whatsapp_message_id)`. Cached at DB level. Worst case: returns undefined, peer falls back to placeholder. |
| Worker change breaks `@lid` send path | Medium | The current direct-sock path at outgoing-whatsapp-worker.js:213-214 exists precisely for `@lid`. We must verify the new `bot.client.sendMessage` also normalizes correctly (it calls `normalizeOutboundJid` which already handles `@lid`). Test it. |
| Migration fails on production DB | Low | `ADD COLUMN IF NOT EXISTS` is idempotent; index creation is idempotent. Runs in `runPostStartupTasks` which retries 5x. |
| Patch in child process not applied early enough | Low | Patch at top of `src/server.js` and `src/workers/ai-worker.js`, before any other require. Libsignal isn't loaded until Baileys is. |

## 9. Out of Scope (Captured for Follow-up)

- **Baileys `rc.10 → rc.13` upgrade.** Separate PR in 2-3 days after this lands and stabilizes. Includes the `proto.Message.AppStateSyncKeyData.fromObject` → `.create()` rewrite.
- **Bot ignores prompt instructions.** Reported by user, scoped out of this spec — likely AI-side, separate investigation.
- **Duplicate replies caused by reasons OTHER than ghost sockets** (e.g. queue retry, ai-worker bug). If the §4.2 fix doesn't fully resolve the duplicates, follow up with a queue-level dedup audit.
- **Dashboard alert for Bad MAC spike rate.** Could add `health_incidents` row when throttle counter exceeds N/minute. Out of scope here; covered in 6.7.x followup if needed.
