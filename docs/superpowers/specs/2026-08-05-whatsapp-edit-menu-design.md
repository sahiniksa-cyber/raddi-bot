# WhatsApp Guided Edit Menu — Design

**Date:** 2026-08-05
**Branch:** `feat/whatsapp-edit-menu` (based on `production`)
**Author:** Claude (acting as technical lead, per owner delegation)

## Problem

Two owner complaints about editing bot settings from the WhatsApp escalation group:

1. **Section hallucination.** Today, `تعديل <free text>` is routed by AI
   (`planConfigEdit`) to guess *which* config section the owner means. It
   guesses wrong sometimes → edits the wrong section. The owner wants to pick
   the section explicitly.
2. **Confirmation loop still recurs.** PR #167 added `claimGroupAction`
   (message-id dedup) — it is on `production`. But it only claims on the
   *initial* command / when a pending already exists, and it fails open when
   `msg.id` is absent. The owner still sees the "propose → confirm → re-propose"
   loop.

## Solution: numbered menu state machine

Replace the free-text-routing entry with an explicit numbered menu, and make the
whole interaction a persisted state machine where **every** advancing message is
idempotency-guarded (not just the first).

### Entry rules
- First token is `برومنت` / `البرومنت` **with a body** → direct prompt edit
  (unchanged shortcut; section is unambiguous, no guessing).
- First token is a **narrow, deliberate** trigger — `تعديل`, `تعديلات`, `عدل`,
  `فلاش`, `قائمة`, `ضبط`, `اعدادات` (typo-tolerant), or bare `برومنت` → open the
  menu (any trailing body is ignored; the menu decides the section). Action
  verbs (`احذف`, `غيّر`, `ضيف`, …) are **not** triggers, so normal team chatter
  that merely starts with such a word never pops the menu.
- Otherwise, if an active session exists for this group → route by its stage.
- Otherwise → return null (not ours).

### The 8 sections
```
1 تعليمات البوت            → botInstructions            (free text → AI merge)
2 المنتجات والأسعار         → products                   (free text → AI plan)
3 الردود الفورية            → autoReplyKeywords           (keyword, then reply)
4 إيقاف البوت لأرقام محددة   → doNotReplyList              (number add / احذف)
5 طريقة رد البوت            → replyStyle.{tone,language,dialect,emoji,length} (sub-menus)
6 عبارات الإغلاق            → replyStyle.closingPhrases   (phrase add / احذف)
7 عبارات التحية             → replyStyle.greetingPhrases  (phrase add / احذف)
8 الكلمات والعبارات الممنوعة → replyStyle.avoidWords / avoidPhrases (sub-choice, then add / احذف)
```

### Stages (persisted per group in `prompt_edit_requests`)
`menu` → `input` | `input_keyword` | `input_reply` | `subattr` | `subvalue` → `confirm` → terminal (`applied`/`rejected`/`expired`).

- **List sections (4,6,7,8):** deterministic. `input` accepts a plain value to
  ADD, or `احذف: X` to remove. Section 8 first asks a sub-choice (كلمة/عبارة).
  No AI. The applier stores a **delta op** (add/remove + field + value), applied
  against freshly-loaded config at confirm time (avoids clobbering concurrent
  edits).
- **Reply style (5):** `subattr` menu (نبرة/لغة/لهجة/إيموجي/طول) → `subvalue`
  menu of that attribute's fixed options → `confirm`. No free text, no AI.
- **Prompt (1):** `input` free text → `ai.proposePromptEdit` → `confirm`.
- **Products (2):** `input` free text → `ai.planConfigEdit`/`applyProductOp`
  → `confirm` (or clarify).
- **Instant replies (3):** `input_keyword` → `input_reply` → `confirm`.

### Idempotency (kills the loop by construction)
1. **Layer 1 — message-id claim on EVERY advancing message.** Reuse
   `claimGroupAction`. Any WhatsApp re-delivery of the same message id at any
   stage is a silent no-op. (Today it only guards the initial step.)
2. **Layer 2 — atomic terminal transitions.** Apply/cancel use
   `UPDATE … WHERE status='pending' RETURNING`; a duplicate confirm finds no
   pending row → cannot double-apply. Menu re-display is naturally idempotent.
   This layer works even when `msg.id` is missing (Layer 1 fails open).

### Cancel / expiry
- `لا` / `الغاء` at any stage cancels the session.
- TTL 10 min (existing `findPendingEdit` logic) expires a stale session.

## Data model
Extend `prompt_edit_requests` (idempotent migration):
- `stage TEXT NOT NULL DEFAULT 'confirm'` — active-session stage.
- `section TEXT` — chosen section key.
- `context JSONB` — per-stage scratch (e.g. `{attr:'tone'}`, pending delta op).

Old rows/behaviour unaffected (default `confirm`). One active row per
`(user_id, source_jid)`; opening a new session expires any prior active one.

## Components (isolation)
- `lib/edit-menu.js` (**pure**): section registry, menu/sub-menu text, parse
  numeric selection, parse `احذف: X`, reply-style attribute/value maps, list
  delta appliers. Fully unit-testable, no I/O.
- `src/services/prompt-edit/prompt-edit.service.js`: the state machine
  (`tryHandle`) driving stages via the session row; reuses `claimGroupAction`,
  `proposePromptEdit`, `planConfigEdit`, appliers. Backward-compatible exports.
- `applySectionValue` extended to accept a nested path (for `replyStyle.*`) or a
  dedicated `applyReplyStyleDelta` — computed against fresh config at confirm.

## Testing (the reliability guarantee)
- **Unit** (`edit-menu.js`): selection parsing, `احذف` parsing, attribute/value
  maps, list add/remove deltas, bounds (invalid number, empty).
- **Integration** (`tryHandle`): a full happy-path test per section
  (open → select → input/subchoice → confirm → correct DB write), plus:
  - **Redelivery idempotency at EVERY stage** (same msg.id twice → one effect).
  - Confirm double-delivery → single apply (atomic).
  - Cancel at each stage. TTL expiry. Invalid menu number → re-prompt.
  - `msg.id` absent → Layer 2 still prevents double-apply.
- Full suite (`node --test`) must be green before "done".

## Out of scope (YAGNI)
- Editing individual product variants field-by-field via sub-menus (products
  stay free-text→AI, with confirm).
- Multi-select / bulk edits in one message.
- Changing the dashboard UI.
