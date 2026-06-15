# Brain + Admin Fixes Implementation Plan (2026-06-14)

> **For agentic workers:** Use superpowers:test-driven-development per task. Steps use `- [ ]`.

**Goal:** Fix 5 reported bot-behaviour/admin issues + ship the already-built pre-activation quota fix, in ONE combined deploy.

**Architecture:** Root cause for #1/#4/#5 is a single thread — new/migrated merchants have no `bot_configs` row → fall back to `DEFAULT_CONFIG` (Gemini model + `medium` emoji). #2/#3 are an independent reply-validator gap (the cop-out regex and escalation tagger miss the "بأراجع … وأكلمك" deflection family). #4 (platform-account migration) needs an admin copy-config tool because everything is keyed by stable `user_id`.

**Tech Stack:** Node.js, @whiskeysockets/baileys, BullMQ/Redis, PostgreSQL, OpenAI/Anthropic/Gemini via OpenRouter-compatible client. Tests: `node --test --test-force-exit`.

**Deploy rule:** combine everything into ONE branch → ONE PR → ONE squash-merge (frequent deploys cause 440/Bad MAC reconnect churn). Do NOT deploy without user permission.

**Known-good baseline:** full suite is 895/896 — the only expected "failure" is `tests/startup-health.test.js` crashing on Windows forced-exit (libuv handle leak, not a real failure).

---

## Task §2: Pre-activation quota fix — ALREADY DONE (cherry-picked `14edf65`)
**Status:** committed on branch as `8d15d88`. Files: `src/db/migrations/init.js`, `src/services/admin/pre-activations.js`, `src/controllers/auth.controller.js`, `src/routes/admin.routes.js`, `dashboard/admin.html`, `tests/admin-pre-activations.test.js`, `tests/pre-activation-grants-quota.test.js`.
- [ ] Run baseline suite; confirm `admin-pre-activations` 12/12 + `pre-activation-grants-quota` pass, no new failures.

## Task #1: Resolve the AI model by available key (stop defaulting to Gemini on an OpenAI key)
**Files:** Modify `lib/ai-client.js` (add `resolveEffectiveModel`, call it in `buildClient`), `lib/constants.js:52` (default model), `lib/ai-client.js` last-resort fallback. Test: `tests/ai-client-model-resolution.test.js` (new).

Root cause: `buildClient()` routes by model string; a `google/*` model with only an OpenAI key throws (`ai-client.js:57`) → fallback message. Default model is Gemini (`constants.js:52`).

- [ ] **Failing test:** assert `resolveEffectiveModel({model:'google/gemini-2.0-flash', openaiApiKey:'sk-'+'x'.repeat(40)})` returns an OpenAI model (not a google/* one); assert it does NOT throw in `buildClient`; assert an OpenRouter key keeps the configured model; assert a Google key keeps Gemini.
- [ ] **Implement** `resolveEffectiveModel(config)`: if OpenRouter key → keep model (OpenRouter serves all); else if model's provider key present → keep; else switch to the available key's default (OpenAI→`gpt-4o-mini`, Google→`google/gemini-2.0-flash`); else keep (buildClient throws helpful error). Use it at the top of `buildClient`.
- [ ] **Change** `DEFAULT_CONFIG.model` `lib/constants.js:52` → `'gpt-4o-mini'` (matches the platform's OpenAI key; works on OpenRouter/Google via resolver). Existing merchants with an explicit model are unaffected.
- [ ] Run new test + `tests/ai-client*.test.js`; commit.

## Task #5: Default to NO emoji unless the merchant opted in
**Files:** Modify `lib/constants.js:67`, `dashboard/index.html:~1932`. Test: extend `tests/reply-validator.test.js` or platform-features prompt test.

Root cause: `emojiLevel:'medium'` default → `describeEmoji` injects a "use an emoji" instruction (`platform-features.js:36-43`).

- [ ] **Failing test:** `buildPlatformPromptBlock({ replyStyle:{} })` emits the `none` emoji text (`describeEmoji('none')`), proving a default merchant is told NOT to emoji. Assert `DEFAULT_CONFIG.replyStyle.emojiLevel === 'none'`.
- [ ] **Implement:** `lib/constants.js:67` `emojiLevel:'none'`; `dashboard/index.html` load fallback `r.emojiLevel||'none'`. Merchants who chose a level keep it (`r.emojiLevel || …`).
- [ ] Run tests; commit.

## Task #2: Detect the deflection cop-out family
**Files:** Modify `src/services/ai/reply-validator.js:132` (extend `COPOUT`). Test: extend `tests/reply-validator.test.js`.

Root cause (verified by running the regex): `COPOUT` misses "بأراجع الموضوع وأكلمك" / "لحظات أراجع وأكلمك" / "أراجع المختص ويرجع لك".

- [ ] **Failing test:** `isCopOut('بأراجع الموضوع وأكلمك') === true`; `isCopOut('لحظات أراجع وأكلمك') === true`; `isCopOut('خلّي أراجع المختص ويرجع لك خلال ساعة') === true`; **negative control** `isCopOut('أرجع لك السعر هو 250 ريال') === false`.
- [ ] **Implement:** add `COPOUT_DEFLECT = /(?:أراجع|اراجع|راجع|أتحقق|اتحقق|أستفسر|استفسر|أشوف|اشوف)[^\n.؟!]{0,30}(?:أكلمك|اكلمك|أرجع لك|ارجع لك|يرجع لك|أرد عليك|ارد عليك|أبلغك|ابلغك|أفيدك|افيدك|نتواصل|أتواصل معك)/;` and `isCopOut` returns `COPOUT.test(t) || COPOUT_DEFLECT.test(t)`.
- [ ] Run tests; commit (combined with #3).

## Task #3: A detected cop-out must force a real escalation (never leave the customer hanging)
**Files:** Modify `src/services/ai/reply-validator.js:113-127` (`enforceEscalationTag`). Test: extend `tests/reply-validator.test.js`.

Root cause: escalation is tag-driven; `enforceEscalationTag` only tags on explicit customer request or a recognized transfer phrase — deflections are invisible to both.

- [ ] **Failing test:** `enforceEscalationTag('بأراجع الموضوع وأكلمك', {escalationContacts:[{name:'المالك',phone:'05...'}]}, 'كم السعر؟')` returns a string ending in `[تحويل:…]`. Guard tests: with NO contacts → returned unchanged (can't escalate); when reply asks customer for info (`replyAsksCustomerForInfo`) and not explicit → not escalated.
- [ ] **Implement:** change the early-return at line 118 to `if (!explicit && !botSignalsTransfer(text) && !isCopOut(text)) return text;`. Keep the `replyAsksCustomerForInfo` and `!contacts.length` guards. Existing caps (`maxEscalationsPerConversation`, 10-min gap in `ai-worker.js`) still throttle.
- [ ] Run `tests/reply-validator.test.js` full; commit.

## Task #4: Admin "copy/transfer merchant settings" tool (account migration)
**Files:** Create `src/services/admin/copy-merchant-config.js`; modify `src/controllers/admin-merchant.controller.js`, `src/routes/admin.routes.js`, `dashboard/admin.html`. Test: `tests/copy-merchant-config.test.js` (new).

Root cause: identity is stable `user_id`; migrating to a new platform account leaves the new `user_id` with no `bot_configs`/`customer_api_keys`/`learned_replies` → behaviour differs even though the prompt was re-entered.

- [ ] **Failing test (fake DB):** `copyMerchantConfig(db, srcUserId, dstUserId)` → dst `bot_configs.config` equals src's (incl. model, products, replyStyle, escalation); `customer_api_keys` rows copied per provider; `learned_replies` rows copied; runs in a transaction; UPSERT on dst (does not crash if dst already has a row); never writes API keys into `bot_configs.config`.
- [ ] **Implement** the service + controller method (resolve both accounts by email, reuse the `consumePreActivationForUser` email→user lookup pattern + the `botAction`/`audit` pattern in `admin-merchant.controller.js`) + route in `admin.routes.js` + a small form in `admin.html` (old email, new email, confirm) posting to the route.
- [ ] Run new test + `tests/admin*.test.js`; commit.

## Integration & verification
- [ ] Integrate #4 (cherry-pick from its worktree branch — disjoint files, clean).
- [ ] Run FULL suite `node --test --test-force-exit`; confirm only `startup-health` Windows-exit crash, everything else green.
- [ ] Push branch, open ONE PR, summarize. Ask user before squash-merge (= the single deploy).

## Self-review notes
- Default-model change only affects configs without an explicit `model`; explicit-model merchants unaffected. Verify `MODEL_PRICES` contains `gpt-4o-mini` (it does — `constants.js:11`).
- Emoji default change only affects configs without an explicit `emojiLevel`.
- Force-escalation preserves the `escalationPausesBot:false` default and the staleness guard (#86) — those run after a tag exists and are untouched.
