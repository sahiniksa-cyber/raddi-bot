# Escalation Bridge (two-way) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the AI escalates a problem to the platform group (or a contact's number), the team member REPLIES to the escalation message (quote/reply) with the solution → the bot relays it to the customer verbatim and the team member keeps the conversation going (customer replies get forwarded back to the group) — the owner never has to take over manually.

**Architecture:** A `whatsapp_message_id → customer` mapping table (`escalation_threads`). The outgoing worker records a row for every escalation/forward message it sends to the team. Inbound ingest gains a pre-check (BEFORE the group-drop and the fromMe routing): a message quoting a known thread message = a team resolution → store as outbound assistant message + enqueue to the customer (no humanization delay — it's a fix, send now) + mute the AI on that conversation for 60 min. While a thread is active (last team-bound message < 60 min old), customer replies are forwarded to the group as "💬 رد العميل" (and recorded as thread rows so the team can quote THEM too). Everything else about groups stays ignored exactly as today.

**Key wiring facts (verified):** group messages reach `ingestWhatsappMessage` and die at line 152 (`@g.us` drop) — hook goes before it; fromMe routing at line 159 (owner quote-replying inside the group arrives as fromMe + @g.us — bridge check must run first); Baileys quoted id lives in `msg.message.<part>.contextInfo.stanzaId` and `toWhatsappWebMessage` (manager:105) doesn't extract it yet; ai-worker escalation payload already carries `customerSender` + `conversationId`; AI mute via `conversations.escalated_until` already respected by the worker.

---

### Task 1: Migration + `escalation-bridge` service (TDD)
Create `src/services/escalation/escalation-bridge.js` + table:
```sql
CREATE TABLE IF NOT EXISTS escalation_threads (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT NOT NULL,
  target_jid TEXT NOT NULL,
  customer_sender TEXT NOT NULL,
  conversation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, whatsapp_message_id)
);
CREATE INDEX IF NOT EXISTS escalation_threads_customer_idx
  ON escalation_threads (user_id, customer_sender, created_at DESC);
```
Exports: `recordThreadMessage`, `findThreadByQuotedId`, `findActiveThreadForCustomer` (window `ESCALATION_BRIDGE_WINDOW_MS` default 60 min), `relayResolutionToCustomer` (insert assistant message status `queued_for_send` + enqueue outgoing delay 0 + set `escalated_until` NOW()+window), `buildCustomerForwardText`. All fail-soft, DI for database/queue. Tests: `tests/escalation-bridge.test.js` (fakeDb capture style).

### Task 2: capture quoted id + record sent escalations (TDD)
- Manager: `quotedStanzaIdFromBaileysMessage(message)` helper (first part with `contextInfo.stanzaId`) + add `quotedStanzaId` to `toWhatsappWebMessage`. Export helper; unit test with extendedTextMessage + imageMessage shapes.
- Outgoing worker: after successful send, `if (payload.escalation && payload.customerSender && sendResult?.key?.id)` → `recordThreadMessage(...targetJid: deliverTo...)` best-effort. Source-structure test.

### Task 3: ingest bridge hooks (TDD)
In `MessageIngestService`:
- `tryEscalationBridge({userId, msg})` — if `msg.quotedStanzaId` matches a thread: take text (skip if empty/media-only), `relayResolutionToCustomer`, return `{accepted:true, bridged:true}`. Called at the TOP of `ingestWhatsappMessage` (before fromMe routing and group drop).
- After saving a normal inbound customer message: `findActiveThreadForCustomer` → if active, enqueue forward to `thread.target_jid` (payload `escalation:true, customerSender` so the worker records the new thread row, making the forward itself quotable). Fire-and-forget.
Tests in `tests/escalation-bridge-ingest.test.js`: group quote-reply relays + mutes + no AI enqueue; unmatched group chatter still ignored; fromMe quote-reply in group bridges; customer message with active thread enqueues forward; without thread, normal flow untouched.

### Task 4: verify + ship
Full-suite batches (excluding known-leaky file) → PR → merge → deploy → live walkthrough for the user (escalate, quote-reply in group, watch customer receive).
