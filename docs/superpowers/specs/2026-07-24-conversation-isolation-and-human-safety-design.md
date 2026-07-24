# Conversation Isolation and Human Safety Design

## Goal

Prevent WhatsApp customer context from crossing tenant or conversation boundaries, make inbound and outbound delivery idempotent under concurrency, and ensure unsafe/low-confidence replies become a real human handoff.

## Scope model

- `user_id` is the current tenant identifier.
- WhatsApp is the channel represented by the `conversations` and `messages` tables; Instagram is physically isolated in separate `instagram_*` tables.
- `sender` is the current WhatsApp customer identifier.
- `conversation_id` is the globally unique conversation identifier.
- Every AI-path query must require both `user_id` and `conversation_id`; message mutations must additionally bind the message row to the same scope.
- BullMQ conversation keys remain based on the globally unique `conversation_id`, while payload validation binds tenant, channel, customer, and conversation before use.

## Data-flow guarantees

1. Ingest stores a provider message only once. A duplicate delivery returns the existing row but never changes a terminal status and never enqueues AI again.
2. AI history, customer profile, recent-reply deduplication, and final review reject calls that omit tenant scope.
3. History ordering uses `(created_at, id)` so equal timestamps are deterministic.
4. Outgoing jobs are untrusted. Before a send, the worker verifies that `replyMessageId`, `userId`, `conversationId`, and `sender` identify the same database row/conversation.
5. Message state changes are tenant/conversation scoped.
6. Database constraints prevent new rows whose tenant/customer do not match the referenced conversation.
7. Automatically learned replies are not injected across customers unless a separate explicit reuse flag is enabled.

## Human-safety guarantees

- The final pre-send review reports confidence and whether a human is required.
- Explicit human requests, refunds/compensation, material payment problems, strong/repeated complaints, contradictions, unsupported facts, and low confidence trigger handoff.
- A transfer marker created at the final review boundary is parsed before WhatsApp delivery; it is never sent literally to the customer.
- The customer gets one short acknowledgement and the configured employee/group gets an idempotent summary job.

## Verification

- A 20-customer concurrent test places a unique secret in each conversation and asserts every generated review context contains only its own secret.
- Regression tests cover duplicate provider delivery, mismatched outgoing job scope, deterministic ordering, mandatory tenant filters, learned-memory default isolation, and pre-send handoff routing.
- The complete Node test suite must pass after targeted tests.
