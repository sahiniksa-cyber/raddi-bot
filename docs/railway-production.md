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
