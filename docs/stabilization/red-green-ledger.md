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

This tracked ledger preserves the useful RED command, counts, and violation paths; the ignored local task report is supplementary only.

## Task 1 review fix round 1/5

Command result after strengthening the test harness: exit code `1`; 7 tests run, 4 focused checks passed, and the same 3 architecture boundaries remained RED.

- Gateway boundary: **7** violations — each configured producer lacks a `WhatsAppSendGateway` import binding, the `preSendReviewRequired` authorization read remains, and the gateway implementation is absent.
- Policy boundary: **14** token occurrences.
- Transport boundary: **10** direct call occurrences.

Focused passing checks cover import-binding-to-receiver linkage, one complete request object containing all required fields, truthy/negated/coerced `preSendReviewRequired` reads, every source-token match on a single line, and dotted/optional/spaced/bracket transport calls.

## Task 1 review fix round 3/5

Tracked verification command (run locally only):

```powershell
node --test tests/architecture/single-policy-source.test.js tests/architecture/single-whatsapp-transport.test.js tests/architecture/mandatory-send-gateway.test.js
```

Observed RED result after the focused harness checks: 7 tests total, 4 focused checks passed, and 3 boundary assertions failed with exit code `1`.

- Gateway: **7** violations at `src/controllers/bot.controller.js`, `src/workers/campaign-worker.js`, `src/workers/outgoing-whatsapp-worker.js`, `src/services/monitoring/alerts.js`, `src/services/monitoring/unlink-alert.js`, `src/services/ai/pre-send-review.js:181`, and the missing `src/services/whatsapp/whatsapp-send-gateway.js`.
- Policy: **14** occurrences in the paths recorded above under the baseline assertion.
- Transport: **10** calls in the paths recorded above under the baseline assertion.

The gateway lexer ignores comments, quoted strings, and complete template literals (including interpolation text) when deriving top-level request properties. The authorization check catches decision contexts, including parenthesized ternary and logical gates, while compatibility assignment, destructuring, and logging remain permitted.
