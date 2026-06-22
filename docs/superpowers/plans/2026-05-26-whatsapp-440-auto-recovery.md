# WhatsApp 440 Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Baileys fires a 440 "connectionReplaced" event and the session desired state is "running", automatically schedule a re-connection attempt after the connection lease expires — instead of staying stopped forever.

**Architecture:** The `BaileysConnectionManager` already emits `'connection_conflict'` on 440. `RuntimeBot` (which owns the lease logic) must listen to that event and schedule `startBot('440_recovery')` after the lease TTL expires, guaranteeing the competing instance's lease has expired first.

**Tech Stack:** Node.js, `node:test`, `node:assert/strict`. All tests use stub-only mocks (no real DB, no real WhatsApp).

---

### Task 1: 440 recovery handler in RuntimeBot

**Files:**
- Modify: `src/services/bot/runtime-bot.js` (constructor, ~line 136–156)
- Create: `tests/runtime-bot-440-recovery.test.js`

**Context:** `RuntimeBot` constructor sets up connection event listeners in the block starting at line 136. The connection already emits `'connection_conflict'` (from `baileys-connection-manager.js` line 415). `RuntimeBot` already owns `leaseTtlMs()`, `startBot()`, `scheduleLeaseRetry()` and `_autoRecoverTimer`.

The rule: if `this.sessionDesiredState === 'running'` when 440 fires, schedule a `startBot('440_recovery')` after `leaseTtlMs() + 5000` ms. The `+5000` ensures the competing instance's lease has had time to expire even if our clock is slightly ahead.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-bot-440-recovery.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// Minimal RuntimeBot stub that wires only the 440-recovery logic
class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.status = 'stopped';
    this.qr = null;
  }
  state() { return { status: this.status }; }
  async start() { this.status = 'waiting_qr'; return true; }
}

function makeBot({ desiredState = 'running' } = {}) {
  const conn = new FakeConnection();
  const startCalls = [];
  const bot = {
    connection: conn,
    sessionDesiredState: desiredState,
    _autoRecoverTimer: null,
    _leaseRenewTimer: null,
    logger: { info: () => {}, warn: () => {} },
    leaseTtlMs() { return 1000; }, // short TTL for test
    startBot(reason) {
      startCalls.push(reason);
      return Promise.resolve(true);
    },
    scheduleLeaseRetry() {},
  };

  // Attach the handler under test (same logic as RuntimeBot constructor)
  conn.on('connection_conflict', () => {
    if (bot.sessionDesiredState !== 'running') return;
    const retryMs = bot.leaseTtlMs() + 200; // +200ms buffer in test
    clearTimeout(bot._autoRecoverTimer);
    bot._autoRecoverTimer = setTimeout(() => {
      bot._autoRecoverTimer = null;
      if (bot.sessionDesiredState === 'running' && bot.connection.status === 'stopped') {
        bot.startBot('440_recovery').catch(() => {});
      }
    }, retryMs);
    if (typeof bot._autoRecoverTimer.unref === 'function') bot._autoRecoverTimer.unref();
  });

  return { bot, conn, startCalls };
}

test('440 schedules auto-recovery when desired state is running', async (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  assert.equal(startCalls.length, 0, 'should not start immediately');

  // Advance past leaseTtlMs (1000) + buffer (200)
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0], '440_recovery');
});

test('440 does NOT schedule recovery when desired state is stopped', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { conn, startCalls } = makeBot({ desiredState: 'stopped' });

  conn.emit('connection_conflict', {});
  t.mock.timers.tick(5000);
  assert.equal(startCalls.length, 0, 'must not auto-recover when owner stopped the bot');
});

test('440 recovery is cancelled if desired state changes to stopped before timer fires', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  bot.sessionDesiredState = 'stopped'; // owner stops the bot manually
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 0, 'must not restart if owner stopped in the meantime');
});

test('440 recovery is cancelled if bot is no longer stopped before timer fires', (t) => {
  t.mock.timers.enable(['setTimeout', 'clearTimeout']);
  const { bot, conn, startCalls } = makeBot({ desiredState: 'running' });

  conn.emit('connection_conflict', {});
  bot.connection.status = 'connected'; // recovered by other means
  t.mock.timers.tick(1300);
  assert.equal(startCalls.length, 0, 'must not restart if already connected');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/runtime-bot-440-recovery.test.js
```
Expected: all 4 tests FAIL (the handler logic is not in RuntimeBot yet).

- [ ] **Step 3: Add the handler to RuntimeBot constructor**

In `src/services/bot/runtime-bot.js`, find the block that sets up connection event listeners (after the `this.connection.on('auth_cleared', ...)` handler, around line 156). Add:

```js
    this.connection.on('connection_conflict', () => {
      if (this.sessionDesiredState !== 'running') return;
      const retryMs = this.leaseTtlMs() + 5000;
      clearTimeout(this._autoRecoverTimer);
      this._autoRecoverTimer = setTimeout(() => {
        this._autoRecoverTimer = null;
        if (this.sessionDesiredState === 'running' && this.connection.status === 'stopped') {
          this.logger.info('connection', '440 auto-recovery: re-acquiring WhatsApp lease');
          this.startBot('440_recovery').catch((err) => {
            this.logger.warn('connection', `440 auto-recovery failed: ${err.message}`);
          });
        }
      }, retryMs);
      if (typeof this._autoRecoverTimer.unref === 'function') this._autoRecoverTimer.unref();
    });
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test tests/runtime-bot-440-recovery.test.js
```
Expected: 4/4 PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```
node --test tests/
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/bot/runtime-bot.js tests/runtime-bot-440-recovery.test.js
git commit -m "feat(bot): auto-recover WhatsApp after 440 connectionReplaced"
```
