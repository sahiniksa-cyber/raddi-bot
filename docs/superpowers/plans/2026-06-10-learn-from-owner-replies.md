# Learn From Owner Replies (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot automatically learns Q→A pairs from the OWNER's own manual replies (the only trusted source — no AI invention, no customer poisoning) and injects them into future AI answers. Fully hands-off, with an audit panel + per-item disable in the dashboard.

**Architecture (approved by owner 2026-06-10):** A periodic learning pass (web process, setInterval like ai-recovery) pairs each owner manual reply (`messages.status='sent_by_human'`) with the latest UNANSWERED inbound customer message before it in the same conversation. Quality-filtered pairs are stored in a new `learned_replies` table (UNIQUE on normalized question = dedup). At AI time, active rows are loaded and merged into the existing knowledge-injection scorer (`retrieveRelevantPolicies`) via a NEW `config.learnedReplies` source — deliberately NOT `autoReplyKeywords`, so instant-reply matching and the merchant's manual list stay untouched. Everything behind `LEARNED_REPLIES_ENABLED` (default on; `false` kills loop + injection instantly).

**Explicitly rejected (per design discussion):** AI rewriting the merchant prompt; learning from customer text as a source of truth; retroactive config edits.

**Key facts (verified):** owner replies = `direction='outbound' AND status='sent_by_human'` (ingest line ~92); knowledge entries enter at `knowledge-retrieval.js:83-88` shape `{keyword, reply}` cap `MAX_INJECTED=6`; ai-worker loads config at `ai-worker.js:510`; loop pattern = `server.js:804` (`unref`, catch); panel template = paused-chats (`index.html:1200` + `server.js:427` + `services/bot/paused-chats.js`); table id pattern = `BIGSERIAL` (escalation_log, init.js:336).

---

### Task 1: Learner service + storage

**Files:**
- Create: `src/services/learning/owner-reply-learner.js`
- Modify: `src/db/migrations/init.js` (append table + index)
- Test: `tests/owner-reply-learner.test.js` (new)

- [ ] **Step 1: Failing tests** — `tests/owner-reply-learner.test.js` with fakeDbCapture pattern (as in tests/message-quota.test.js):
  - `isLearnablePair`: rejects short question (<8 chars), short answer, media placeholders (`[صورة`/`[ملف`/`[صوت`), pure greetings (وعليكم السلام وحدها), answers containing `[تحويل:`; accepts a real Q→A.
  - `normalizeQuestion`: Arabic-normalized + trimmed + lowercased (reuse normalizeArabic from escalation-routing).
  - `saveLearnedReplies`: INSERT SQL has `ON CONFLICT (user_id, normalized_question) DO NOTHING`; caps at `MAX_PER_RUN=20`; skips when active count >= `MAX_TOTAL=300` (first query is a COUNT).
  - `loadActiveLearnedReplies`: returns entries shaped `{keyword: question, reply: 'إذا سُئلت "..." فجواب صاحب المتجر: ...'}`; returns [] when `LEARNED_REPLIES_ENABLED==='false'` or db not configured.
  - `extractLearnablePairs`: SQL filters `status='sent_by_human'`, pairs via LATERAL latest unanswered inbound (`status <> 'answered_by_ai'`, same conversation, within 6h before).
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3: Implement** module exporting `isLearnablePair, normalizeQuestion, extractLearnablePairs, saveLearnedReplies, loadActiveLearnedReplies, listLearnedReplies, setLearnedReplyStatus, runLearningPass`. Migration:

```sql
CREATE TABLE IF NOT EXISTS learned_replies (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  source_conversation_id UUID,
  source_message_id UUID,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, normalized_question)
);
CREATE INDEX IF NOT EXISTS learned_replies_user_status_idx ON learned_replies (user_id, status);
```

- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat(learning): owner-reply learner service + learned_replies storage`.

---

### Task 2: Injection into knowledge retrieval + AI worker

**Files:**
- Modify: `src/services/ai/knowledge-retrieval.js:83-88` (merge `config.learnedReplies` entries)
- Modify: `src/workers/ai-worker.js` (~line 510: attach learned entries to config)
- Tests: `tests/knowledge-retrieval-learned.test.js` (new) + extend `tests/ai-worker-quota.test.js`-style source assertion in the new file

- [ ] **Step 1: Failing tests** — retrieveRelevantPolicies includes learnedReplies entries in scoring/injection; merchant autoReplyKeywords coexist; MAX_INJECTED cap holds; malformed learned entries (missing fields) are skipped. Source test: ai-worker.js contains `loadActiveLearnedReplies` after `resolveConfigForAI`.
- [ ] **Step 2:** FAIL. **Step 3: Implement**:

```js
  const learnedEntries = (Array.isArray(config.learnedReplies) ? config.learnedReplies : [])
    .map(e => ({ keyword: String(e.keyword || '').trim(), reply: String(e.reply || '').trim() }))
    .filter(e => e.keyword && e.reply);
  const entries = [...manualEntries, ...learnedEntries];
```

ai-worker (after line 510): `config.learnedReplies = await loadActiveLearnedReplies({ userId }).catch(() => []);`

- [ ] **Step 4:** PASS + run `tests/knowledge-retrieval.test.js` + `tests/ai-client-knowledge-injection.test.js` for regressions. **Step 5: Commit** `feat(learning): inject learned owner replies into the AI knowledge block`.

---

### Task 3: Periodic learning loop + dashboard panel + routes

**Files:**
- Modify: `src/server.js` (startLearningLoop after startAiRecoveryLoop; routes near /api/paused-chats)
- Modify: `dashboard/index.html` (panel after pausedPanel; loader called next to loadPausedChats)
- Test: extend `tests/owner-reply-learner.test.js` (runLearningPass orchestration with fakeDb)

- [ ] **Step 1: Failing test** — `runLearningPass`: queries distinct users with recent sent_by_human, extracts, filters, saves; returns `{users, learned}` counts; swallows per-user errors.
- [ ] **Step 2:** FAIL. **Step 3: Implement**:
  - server.js: `const LEARNING_PASS_INTERVAL_MS = parseInt(process.env.LEARNING_PASS_INTERVAL_MS || '21600000', 10);` (6h) + loop with unref + first run after 2 min (setTimeout unref). Routes: `GET /api/learned-replies` (list), `POST /api/learned-replies/toggle` ({id} flips active/disabled) — both requireAuth, scoped by session userId.
  - Dashboard: panel `🧠 ردود تعلّمها البوت منك` listing question→answer rows + toggle button (template: pausedPanel; loader called alongside loadPausedChats).
- [ ] **Step 4:** PASS + neighbors (`tests/paused-chats.test.js`, `tests/health-monitor.test.js`). **Step 5: Commit** `feat(learning): 6-hourly learning pass + dashboard review panel`.

---

### Task 4: Verification + ship

- [ ] Full suite in 3 batches excluding `runtime-bot-stability-fixes.test.js` (run it individually, capped) — ALL PASS.
- [ ] `git diff origin/master...HEAD --stat` — only intended files.
- [ ] Push + PR (separate from #61), body includes design rationale + flags (`LEARNED_REPLIES_ENABLED`, `LEARNING_PASS_INTERVAL_MS`) + rollback note.
- [ ] Post-merge verification: reply manually to an unanswered test question from the phone, wait for the learning pass (or set `LEARNING_PASS_INTERVAL_MS=60000` temporarily), confirm the pair appears in the dashboard panel and the bot answers the same question afterwards.
