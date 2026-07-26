# Production stabilization RED/GREEN ledger

## Task 1 — architecture boundaries

Status: RED verified on baseline.

Command:

```powershell
node --test tests/architecture/single-policy-source.test.js tests/architecture/single-whatsapp-transport.test.js tests/architecture/mandatory-send-gateway.test.js
```

Baseline result: exit code `1`; 3 tests run, 0 passed, 3 failed.

Failing assertions and violation counts:

- `single-policy-source.test.js` — `botInstructions must be confined...`; **14** occurrences: the AI client, default config, quality gate (2), product knowledge, prompt edit service (5), escalation routing (2), and two evaluation fixtures.
- `single-whatsapp-transport.test.js` — `Direct WhatsApp transport calls must move...`; **10** direct `client.sendMessage` / `sock.sendMessage` calls across the bot controller, alerts, unlink alert, Baileys connection manager, campaign worker (3), and outgoing worker (3).
- `mandatory-send-gateway.test.js` — `Every WhatsApp producer must use...`; **11** violations: missing `WhatsAppSendGateway` imports/invocations for the configured producers, the `preSendReviewRequired` authorization switch in `src/services/ai/pre-send-review.js:181`, and a missing gateway request constructor.

The full baseline command output is preserved in the Task 1 report.
