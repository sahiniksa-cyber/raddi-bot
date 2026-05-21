# OpenAI Media Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable OpenAI-powered image and audio analysis for WhatsApp messages while preserving the selected conversation model.

**Architecture:** WhatsApp adapters attach normalized media metadata to inbound messages. A focused media analyzer converts media into text before the existing AI reply path builds history and calls the selected model. AI jobs are debounced per conversation so rapid customer messages become one answer.

**Tech Stack:** Node.js, node:test, OpenAI SDK, BullMQ, PostgreSQL JSONB metadata, Baileys, whatsapp-web.js.

---

### Task 1: Media Normalization

**Files:**
- Create: `src/services/ai/openai-media-analysis.js`
- Test: `tests/openai-media-analysis.test.js`

- [ ] Write tests for supported image/audio media, unsupported types, and size limits.
- [ ] Implement `normalizeMediaPayload(media, options)`.
- [ ] Implement `buildMediaAnalysisText({ kind, resultText })`.
- [ ] Run `node --test tests/openai-media-analysis.test.js`.

### Task 2: OpenAI Analysis Client

**Files:**
- Modify: `src/services/ai/openai-media-analysis.js`
- Test: `tests/openai-media-analysis.test.js`

- [ ] Write tests using a fake OpenAI client for image prompt payloads.
- [ ] Write tests using a fake OpenAI client for audio transcription payloads.
- [ ] Implement `OpenAIMediaAnalyzer.analyze(media, context)`.
- [ ] Return structured fallback results instead of throwing for missing key, unsupported media, or API failure.

### Task 3: WhatsApp Media Extraction

**Files:**
- Modify: `src/services/whatsapp/message-ingest.service.js`
- Modify: `src/services/whatsapp/baileys-connection-manager.js`
- Modify: `src/services/whatsapp/connection-manager.js`
- Test: `tests/message-ingest-media.test.js`

- [ ] Write ingest tests proving media-only messages are accepted when media is present.
- [ ] Add optional `media` to normalized message objects.
- [ ] For Baileys, download media bytes and attach base64, MIME, and kind before ingest.
- [ ] For whatsapp-web.js, use `msg.downloadMedia()` when `hasMedia` is true.
- [ ] Keep text-only behavior unchanged.

### Task 4: AI Worker Media Handling and Batching

**Files:**
- Modify: `src/queues/message-queue.js`
- Modify: `src/workers/ai-worker.js`
- Modify: `src/workers/ai-history.js`
- Test: `tests/ai-worker-media-batching.test.js`

- [ ] Write tests for per-conversation AI job key and debounce delay.
- [ ] Write tests that worker loads pending inbound messages since the last assistant reply.
- [ ] Convert media raw payload into text before final history construction.
- [ ] Mark included inbound messages as handled or answered so they are not replied to twice.

### Task 5: Escalation Templates

**Files:**
- Modify: `src/workers/escalation-routing.js`
- Modify: `dashboard/index.html`
- Test: `tests/escalation-routing.test.js`

- [ ] Write tests for `messageTemplate` variable replacement.
- [ ] Add a dashboard field for notification format per escalation contact.
- [ ] Persist `messageTemplate` in `escalationContacts`.
- [ ] Preserve the existing default template when the field is empty.

### Task 6: Start Feedback

**Files:**
- Modify: `src/controllers/bot.controller.js`
- Modify: `dashboard/index.html`
- Test: `tests/bot-controller-start-feedback.test.js`

- [ ] Write tests for start response messages by status.
- [ ] Add helper to map connection state to Arabic user-facing guidance.
- [ ] Keep HTTP success/error behavior compatible with current dashboard calls.

### Task 7: Verification

**Files:**
- Existing tests and `package.json`

- [ ] Run focused tests after each task.
- [ ] Run `npm test`.
- [ ] Inspect `git diff` for accidental unrelated changes.
- [ ] Summarize remaining operational risks: API cost, file size limits, provider availability.
