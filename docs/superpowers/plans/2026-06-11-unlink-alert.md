# Instant Unlink Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The MOMENT a WhatsApp link is truly severed (`DisconnectReason.loggedOut` — device removed / unlinked), notify the owner & customer service with an actionable Arabic message containing the re-link URL — instead of today's ~4-minute generic monitor incident.

**Architecture:** Event-driven, layered on existing infra. The Baileys manager's `loggedOut` branch emits a new `logged_out` event → RuntimeBot listener fires `sendUnlinkAlert` (new `src/services/monitoring/unlink-alert.js`, configured at server boot with `getOwnerBot` + `mailer`, mirroring `createAlertDispatcher` wiring). Channels best-effort: WhatsApp via the ADMIN bot to `OWNER_ALERT_PHONE` + the affected merchant's own phone, and email via the existing mailer. Per-user cooldown prevents spam. The slower health-monitor path stays as the safety net for non-loggedOut outages — its WhatsApp incident message also gains the re-link URL.

**Known limitation (stated honestly):** if the ADMIN's own bot is the one unlinked, the WhatsApp channel cannot work (the sender is the dead session) — email is the only instant channel for that case and requires `SMTP_HOST/USER/PASS` + `OWNER_ALERT_EMAIL` env vars in Railway.

**Verified facts:** loggedOut branch at `baileys-connection-manager.js:502-517`; RuntimeBot listener pattern at `runtime-bot.js:145-205`; dispatcher wiring + `resolveOwnerBot` at `server.js:139,933-943`; mailer needs SMTP envs (`services/notify/mailer.js`); monitor whatsapp check flags only after `MONITOR_WA_STALE_MS` (3 min) + 60s ticks.

---

### Task 1: `unlink-alert` service (TDD)
**Files:** Create `src/services/monitoring/unlink-alert.js`; Test `tests/unlink-alert.test.js`.
- `configureUnlinkAlerts({ getOwnerBot, mailer, database })` — module singleton deps (pattern: `setActiveMonitor`).
- `buildUnlinkMessage({ phone })` — Arabic: 🚨 انفصل ربط واتساب (+phone) / البوت متوقف عن الرد / أعد الربط الآن: `DASHBOARD_URL` (default `https://jwap.net`) / الوقت بتوقيت الرياض.
- `sendUnlinkAlert({ userId, phone })` — guards: `UNLINK_ALERT_ENABLED!=='false'`, per-user cooldown `UNLINK_ALERT_COOLDOWN_MS` (default 30 min, in-memory Map exported as `__lastSent` for tests). Channels best-effort: (a) admin bot → `OWNER_ALERT_PHONE`; (b) admin bot → merchant phone from `users.phone` (skip if same as owner phone); (c) mailer → `OWNER_ALERT_EMAIL` + user email. Returns `{ channels: [...] }`, never throws.
- Tests: message contains URL + phone; cooldown blocks 2nd call; channels recorded with fake bot/mailer; disabled flag → `{channels:[]}`; dead admin bot (status≠connected) → falls through to email without throwing.

### Task 2: emit + listen (TDD)
**Files:** Modify `baileys-connection-manager.js` (in loggedOut branch, before `emit('disconnected')`: `this.emit('logged_out', technicalMessage);`); Modify `runtime-bot.js` (after `connection_conflict` listener: `this.connection.on('logged_out', (detail) => { sendUnlinkAlert({ userId: this.userId, phone: this.connection.phone }).catch(() => {}); });` + require); Modify `server.js` (call `configureUnlinkAlerts({ getOwnerBot: resolveOwnerBot, mailer: createMailer() })` next to dispatcher creation).
- Tests (source-structure, matching repo convention): manager emits `logged_out` inside the loggedOut branch; runtime-bot wires the listener; server configures the service.

### Task 3: monitor incident message gains the re-link URL
**Files:** Modify `alerts.js` `formatIncidentMessage` — when `incident.key?.startsWith('whatsapp:')` or component starts with 'واتساب', append: `\n\nلإعادة الربط: <DASHBOARD_URL>` ; Test extends `tests/health-monitor.test.js` or new small test.

### Task 4: verify + ship
- Full-suite batches (excluding known-leaky file) → ALL PASS; PR; merge; deploy; confirm health.
- Tell the user which Railway envs to set: `OWNER_ALERT_PHONE` (رقم ثاني يستقبل التنبيه), and for the admin-bot-itself case: `SMTP_HOST/SMTP_USER/SMTP_PASS/OWNER_ALERT_EMAIL`.
