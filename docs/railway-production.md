# Railway Production Setup

## Required Variables

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`
- `WA_ENGINE=baileys`

## Start Command

Use the repository default Railway command:

```bash
npm run start:all
```

## First WhatsApp Link

1. Open the hosted dashboard URL.
2. Log in.
3. Press the bot start button.
4. Wait for the QR screen.
5. Scan it from WhatsApp linked devices.
6. After it connects, the Baileys auth state is saved in PostgreSQL.

## Health Checks

- `/health` confirms the web process is alive.
- `/ready` confirms PostgreSQL and Redis are reachable.

## AI Replies

Incoming WhatsApp messages are stored in PostgreSQL, then queued through Redis and BullMQ. The AI worker loads `memoryMessages` from the dashboard config. The default is 50 recent messages per conversation.

If the AI provider fails because an API key is missing or the provider returns an error, the inbound message is marked as `ai_failed` so the failure is visible in data instead of staying silently stuck.

### Reply quality gate

Customer-facing AI drafts pass through an independent review before they are
stored or enqueued. The review checks customer intent, unanswered questions,
merchant instructions, unsupported facts, line formatting, and emoji use.
Numeric commercial claims (prices, durations, percentages, measurements) and
URLs also have a deterministic source check against merchant-owned config.

Production defaults:

```bash
REPLY_QUALITY_GATE_ENABLED=true
REPLY_QUALITY_GATE_TIMEOUT_MS=15000
REPLY_VALIDATOR_ENABLED=true
KNOWLEDGE_INJECTION_ENABLED=true
AI_WORKER_LOCK_DURATION_MS=180000
```

The reviewer is correctness-first. If the review call fails, an unreviewed
factual answer is not sent; the customer receives a truthful retry-later reply.
If a hard unsupported price/duration/URL is detected, the existing escalation
path is used when the merchant has an escalation contact. A compact public
audit (`status`, `decision`, violation codes, latency, and hard-fallback flag)
is stored under `messages.raw_payload.qualityGate`; no private reasoning is
stored.
